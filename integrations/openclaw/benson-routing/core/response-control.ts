import { type Admission, type NoRunOutcome, type TaskResult, type Response, type RenderedOutput } from './contracts.js';
import { type SourceAdmissionController } from './request-control.js';
import { validateRenderedOutput, validateResponseEnvelope } from './legacy-response.js';
import { assertion, boundedCopy, exhaustive, fail, freeze, plain, synchronous, type JsonValue } from './value.js';

export type Presentation = Readonly<{ kind: 'rendered'; text: string; pendingContext: JsonValue }> |
  Readonly<{ kind: 'unsupported'; reason: string }>;
export interface PresentationOptions { language: 'en' | 'he'; now: string; timezone: string }
/** Domain wording belongs to the domain owner; this Port supplies no authority. */
export interface PresentationRenderer {
  (result: TaskResult, options: PresentationOptions): Presentation;
}
export interface ResponseOptions extends Partial<PresentationOptions> { renderResult?: PresentationRenderer }
export interface ReadResponseOptions<A extends Admission = Admission> {
  controller: SourceAdmissionController<A>;
  admission: A;
  renderOutcome(outcome: NoRunOutcome): unknown;
}
export type ReadResponse = Readonly<{ mode: 'suppressed'; outcome: NoRunOutcome; rendered: null }> |
  Readonly<{ mode: 'deterministic'; outcome: NoRunOutcome; rendered: RenderedOutput }>;
function samePending(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function candidateAllowed(response: Response, language: 'en' | 'he', rendered: Presentation): boolean {
  const c = response.messageCandidate;
  const ordinaryMain = response.results.length === 0 && response.source.type === 'main' && response.status === 'success' &&
    response.provenance.executionVerified === 'not_applicable' && response.lifecycle.domainExecution === 'none' && response.lifecycle.failure === null;
  return c !== null && c.language === language && (ordinaryMain || (rendered.kind === 'rendered' && rendered.text === c.text &&
    samePending(rendered.pendingContext, response.pendingContext)));
}
function safeFailure(response: Response, language: 'en' | 'he'): RenderedOutput {
  const base = language === 'he'
    ? response.results.length === 0
      ? response.lifecycle.domainExecution === 'none'
        ? 'לא הצלחתי להכין תשובה מאומתת. נסה שוב מאוחר יותר.'
        : 'לא הצלחתי לאמת תוצאה סופית. ייתכן שהפעולה בוצעה; לא אבצע אותה שוב אוטומטית.'
      : response.status === 'success'
        ? 'הפעולה דווחה כהצלחה, אך אין לי ניסוח מאומת לפרטיה. לא אבצע אותה שוב אוטומטית.'
        : 'לא הצלחתי לאמת תשובה מלאה על תוצאת הפעולה. ייתכן שהיו לה השפעות; לא אבצע אותה שוב אוטומטית.'
    : response.results.length === 0
      ? response.lifecycle.domainExecution === 'none'
        ? 'I could not prepare a verified response. Please try again later.'
        : 'I cannot verify a final outcome. The operation may have had effects; I will not repeat it automatically.'
      : response.status === 'success'
        ? 'The operation was reported successful, but I cannot safely summarize its details. I will not repeat it automatically.'
        : 'I cannot verify a complete response about the operation. It may have had effects; I will not repeat it automatically.';
  const warnings = response.results.some(result => result.warnings.length) ? [language === 'he'
    ? 'דווחו אזהרות נוספות, אך איני יכול להציג את פרטיהן בבטחה.'
    : 'Additional warnings were reported, but I cannot safely summarize their details.'] : [];
  return validateRenderedOutput({ schemaVersion: 2, message: [base, ...warnings].join('\n') });
}
export function controlResponse(raw: unknown, options: ResponseOptions | ReadResponseOptions = {}) {
  if (plain(raw) && raw.kind === 'benson.no-run') {
    if (!('controller' in options)) fail('read_response_dependencies_unavailable');
    return controlReadResponse(raw, options);
  }
  if ('controller' in options) fail('response_language_invalid');
  const response = validateResponseEnvelope(raw);
  const language = options.language;
  if (language !== 'en' && language !== 'he') fail('response_language_invalid');
  const { now, timezone } = options;
  if (typeof now !== 'string' || !/^\d{4}-\d\d-\d\dT/u.test(now) || !Number.isFinite(Date.parse(now))) fail('response_clock_invalid');
  if (typeof timezone !== 'string' || !timezone.trim()) fail('response_timezone_invalid');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { return fail('response_timezone_invalid'); }
  let rendered: Presentation = { kind: 'unsupported', reason: 'not_single_reviewed_domain_result' };
  const single = response.results[0];
  if (response.results.length === 1 && single && response.lifecycle.failure === null && response.status === single.status && options.renderResult) {
    const result = synchronous(options.renderResult(single, { language, now, timezone }), 'response_renderer_must_be_synchronous');
    // A typed renderer can still be supplied by untyped composition code.
    if (!result || typeof result !== 'object' || !('kind' in result)) fail('response_renderer_invalid');
    rendered = result.kind === 'rendered' && 'text' in result && typeof result.text === 'string' && 'pendingContext' in result
      ? { kind: 'rendered', text: result.text, pendingContext: boundedCopy(result.pendingContext) }
      : { kind: 'unsupported', reason: 'semantic_rendering_required' };
  }
  const modes = [response.responsePolicy.preferredMode, ...response.responsePolicy.allowedModes.filter(mode => mode !== response.responsePolicy.preferredMode)];
  for (const mode of modes) {
    switch (mode) {
      case 'pass_through':
        if (candidateAllowed(response, language, rendered) && response.messageCandidate) {
          return freeze({ mode, rendered: validateRenderedOutput({ schemaVersion: 2, message: response.messageCandidate.text }) });
        }
        break;
      case 'deterministic':
        if (rendered.kind === 'rendered' && samePending(rendered.pendingContext, response.pendingContext)) {
          return freeze({ mode, rendered: validateRenderedOutput({ schemaVersion: 2, message: rendered.text }) });
        }
        break;
      case 'safe_failure': return freeze({ mode, rendered: safeFailure(response, language) });
      // Existing inactive modes have no model/orchestration implementation here.
      case 'response_model': case 'main_continuation': break;
      default: exhaustive(mode);
    }
  }
  return fail('response_mode_unavailable');
}
export function controlReadResponse<A extends Admission>(raw: unknown, options: ReadResponseOptions<A>): ReadResponse {
  if (typeof options?.controller?.validateOutcome !== 'function' || typeof options.controller.assertCurrent !== 'function' ||
    typeof options.renderOutcome !== 'function') fail('read_response_dependencies_unavailable');
  const { controller, admission, renderOutcome } = options;
  const outcome = synchronous(controller.validateOutcome(admission, raw), 'read_response_validator_must_be_synchronous');
  if (outcome.schemaVersion !== 2) fail('read_response_native_invocation_required');
  if (outcome.disposition === 'suppressed' || outcome.disposition === 'reasoning-required') {
    assertion(controller.assertCurrent(admission), 'source_authority_must_be_synchronous');
    return freeze({ mode: 'suppressed', outcome, rendered: null });
  }
  const rendered = validateRenderedOutput(synchronous(renderOutcome(outcome), 'read_response_renderer_must_be_synchronous'));
  assertion(controller.assertCurrent(admission), 'source_authority_must_be_synchronous');
  return freeze({ mode: 'deterministic', outcome, rendered });
}
