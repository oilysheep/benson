import { isDeepStrictEqual } from 'node:util';
import { type Admission, type NativeDispatchReadAdmission, type NativeDispatchRunAdmission, type NoRunOutcome, type TaskResult, type Response, type ResponseV3, type ResponseV4, type DomainResult, type AnyDomainResult, type RenderedOutput } from './contracts.js';
import { type SourceAdmissionController } from './request-control.js';
import { validateRenderedOutput, validateResponseEnvelope, validateResponseV3Envelope, validateResponseV4Envelope } from './legacy-response.js';
import { assertion, boundedCopy, exhaustive, fail, freeze, plain, synchronous, type JsonValue } from './value.js';

export type Presentation = Readonly<{ kind: 'rendered'; text: string; pendingContext: JsonValue }> |
  Readonly<{ kind: 'unsupported'; reason: string }>;
export interface PresentationOptions { language: 'en' | 'he'; now: string; timezone: string }
/** Domain wording belongs to the domain owner; this Port supplies no authority. */
export interface PresentationRenderer {
  (result: TaskResult, options: PresentationOptions): Presentation;
}
export interface ResponseOptions extends Partial<PresentationOptions> { renderResult?: PresentationRenderer }
export interface ResponseV3Options extends Partial<PresentationOptions> {
  assertResponseCurrent(response: Readonly<ResponseV3>): unknown;
  renderDomainResult?(result: DomainResult, options: PresentationOptions): Presentation;
}
export interface ResponseV4Options extends Partial<PresentationOptions> {
  assertResponseCurrent(response: Readonly<ResponseV4>): unknown;
  renderDomainResult?(result: AnyDomainResult, options: PresentationOptions): Presentation;
}
type DomainResponse = ResponseV3 | ResponseV4;
interface DomainResponseOptions extends Partial<PresentationOptions> {
  assertResponseCurrent(response: Readonly<DomainResponse>): unknown;
  renderDomainResult?(result: AnyDomainResult, options: PresentationOptions): Presentation;
}
function assertDomainResponse(response: DomainResponse, options: ResponseOptions | DomainResponseOptions): asserts options is DomainResponseOptions {
  if (!('assertResponseCurrent' in options) || typeof options.assertResponseCurrent !== 'function') fail('response_v3_authority_unavailable');
  assertion(options.assertResponseCurrent(response), 'response_v3_authority_unavailable');
}
/** Request-local Controller adapter. The default raw-delivery mode retains its
 * existing contract; native-resolver mode only prepares an authorized handoff.
 * Native admission, route custody, transport and receipts remain host-owned.
 */
interface DeliveryOptions {
  requestId: string;
  agentId: string;
  assertCurrent(): unknown;
  responseFor(payload: unknown): unknown;
  presentation: ResponseOptions | DomainResponseOptions;
}
type DeliveryMode = { mode?: never; deliver(payload: Readonly<{ text: string }>): Promise<void> } |
  { mode: 'native-resolver'; deliver?: never };
/** Compatibility entry: still requires the actual Main Run binding. */
export function createMainResponseDelivery(options: DeliveryOptions & DeliveryMode & { runId(): string }) {
  return createBoundResponseDelivery({ ...options, binding: { type: 'main', runId: options.runId } });
}
/** Explicit read-only direct binding; admission data is correlation, while the
 * currentness and Response callbacks retain private execution/result custody. */
export function createDirectReadResponseDelivery(options: DeliveryOptions & DeliveryMode & {
  admission: NativeDispatchReadAdmission; presentation: DomainResponseOptions;
}) {
  return createBoundResponseDelivery({ ...options, binding: { type: 'direct-read', admission: options.admission } });
}
/** The host retains original admission and controlled Completion/result custody;
 * a Run ID or serialized v4 admission alone cannot authorize a response. */
export function createDirectAgenticResponseDelivery(options: DeliveryOptions & DeliveryMode & {
  admission: NativeDispatchRunAdmission; runId(): string; presentation: DomainResponseOptions;
}) {
  return createBoundResponseDelivery({ ...options, binding: { type: 'direct-agentic', admission: options.admission, runId: options.runId } });
}
function createBoundResponseDelivery(options: DeliveryOptions & DeliveryMode & {
  binding: { type: 'main'; runId(): string } | { type: 'direct-read'; admission: NativeDispatchReadAdmission } |
    { type: 'direct-agentic'; admission: NativeDispatchRunAdmission; runId(): string };
}) {
  let outcome: 'pending' | 'blocked' | 'prepared' | 'sending' | 'delivered' | 'unknown' = 'pending';
  let failure: string | null = null;
  let preparedText: string | undefined, nativeClaimed = false;
  let revalidatePrepared: (() => void) | undefined;
  function prepareCandidate(payload: unknown) {
    if (outcome !== 'pending') fail('main_response_already_settled');
    // Fence synchronous reentry as well as overlapping/duplicate candidates.
    outcome = 'blocked';
    try {
      assertion(options.assertCurrent(), 'main_response_authority_unavailable');
      const raw = synchronous(options.responseFor(payload), 'main_response_must_be_synchronous');
      const response = plain(raw) && raw.schemaVersion === 4 ? validateResponseV4Envelope(raw) :
        plain(raw) && raw.schemaVersion === 3 ? validateResponseV3Envelope(raw) : validateResponseEnvelope(raw);
      if (response.requestId !== options.requestId || response.source.agentId !== options.agentId) fail('main_response_binding_invalid');
      if (options.binding.type === 'main') {
        const runId = synchronous(options.binding.runId(), 'main_response_run_must_be_synchronous');
        if (response.source.type !== 'main' || response.source.runId !== runId) fail('main_response_binding_invalid');
      } else if (options.binding.type === 'direct-agentic') {
        const admission = options.binding.admission;
        const runId = synchronous(options.binding.runId(), 'main_response_run_must_be_synchronous');
        if (admission.schemaVersion !== 4 || admission.scope !== 'read' || admission.authority.kind !== 'native-dispatch' ||
          admission.requestId !== options.requestId || (response.schemaVersion !== 3 && response.schemaVersion !== 4) ||
          response.source.type !== 'direct' || response.source.executionMode !== 'agentic' || response.source.runId !== runId ||
          response.results.length !== 1 || response.results[0]?.domain !== admission.domain ||
          response.results[0]?.effects.status !== 'none') fail('direct_agentic_response_binding_invalid');
      } else {
        const admission = options.binding.admission;
        const expected = { authorityKind: 'native-dispatch', requestId: admission.requestId,
          domain: admission.domain, subject: admission.authority.subject };
        if (admission.schemaVersion !== 3 || admission.scope !== 'read' || admission.requestId !== options.requestId ||
          admission.authority.kind !== 'native-dispatch' || (response.schemaVersion !== 3 && response.schemaVersion !== 4)) fail('direct_read_response_binding_invalid');
        const source = response.source;
        if (source.type !== 'direct' || source.executionMode !== 'deterministic') fail('direct_read_response_binding_invalid');
        if (Object.entries(expected).some(([key, value]) => Reflect.get(source.admission, key) !== value)) fail('direct_read_response_binding_invalid');
      }
      const controlled = controlResponse(response, options.presentation);
      if (!controlled.rendered) fail('main_response_rendering_unavailable');
      const prepared = Object.freeze({ text: controlled.rendered.message });
      assertion(options.assertCurrent(), 'main_response_authority_unavailable');
      if (response.schemaVersion === 3 || response.schemaVersion === 4) assertDomainResponse(response, options.presentation);
      revalidatePrepared = () => {
        assertion(options.assertCurrent(), 'main_response_authority_unavailable');
        if (response.schemaVersion === 3 || response.schemaVersion === 4) assertDomainResponse(response, options.presentation);
      };
      return prepared;
    } catch (error) {
      failure = 'MAIN_RESPONSE_BLOCKED';
      throw error;
    }
  }
  return Object.freeze({
    snapshot: () => Object.freeze({ outcome, failure }),
    prepare(payload: unknown): Readonly<{ text: string }> {
      if (options.mode !== 'native-resolver') fail('main_response_native_mode_required');
      const prepared = prepareCandidate(payload);
      outcome = 'prepared'; preparedText = prepared.text;
      // This is not a transport receipt. The caller must preserve native payload
      // metadata, cancel its dispatch on rejection, and use native settlement.
      return prepared;
    },
    async resolveNativeCandidate(input: {
      resolve(): Promise<unknown>;
      copyMetadata(source: unknown, approved: Readonly<{ text: string }>): unknown;
      signal?: AbortSignal;
    }): Promise<unknown> {
      if (options.mode !== 'native-resolver') fail('main_response_native_mode_required');
      try {
        input.signal?.throwIfAborted();
        const resolved = await input.resolve();
        input.signal?.throwIfAborted();
        const candidates = (Array.isArray(resolved) ? resolved : resolved ? [resolved] : [])
          .filter(value => !plain(value) || value.isFallbackNotice !== true);
        if (candidates.length !== 1) fail('main_response_terminal_candidate_required');
        const approved = this.prepare(candidates[0]);
        const native = synchronous(input.copyMetadata(candidates[0], approved), 'main_response_metadata_must_be_synchronous');
        input.signal?.throwIfAborted();
        return native;
      } catch (error) {
        outcome = 'blocked'; failure = 'MAIN_RESPONSE_BLOCKED';
        throw error;
      }
    },
    beforeNativeDeliver<T>(payload: T, info: { kind: string }): T | null {
      if (options.mode !== 'native-resolver') fail('main_response_native_mode_required');
      if (outcome !== 'prepared' || nativeClaimed) return null;
      nativeClaimed = true;
      try {
        if (info.kind !== 'final' || !plain(payload) || Reflect.ownKeys(payload).length !== 1) fail('main_response_native_payload_changed');
        const text = Object.getOwnPropertyDescriptor(payload, 'text');
        if (!text || !('value' in text) || text.value !== preparedText) fail('main_response_native_payload_changed');
        // Native custody is kept in its supported metadata store, not extra
        // logical payload fields. Fence every other content/delivery surface.
        Object.freeze(payload);
        if (!revalidatePrepared) fail('main_response_authority_unavailable');
        revalidatePrepared();
        return payload;
      } catch {
        outcome = 'blocked'; failure = 'MAIN_RESPONSE_BLOCKED';
        return null;
      }
    },
    async deliver(payload: unknown, info: { kind: string }): Promise<void> {
      if (options.mode === 'native-resolver') fail('main_response_raw_mode_required');
      if (info.kind !== 'final') fail('main_response_final_required');
      const prepared = prepareCandidate(payload);
      outcome = 'sending';
      try {
        await options.deliver(prepared);
        outcome = 'delivered';
      } catch (error) {
        outcome = 'unknown';
        failure = 'MAIN_RESPONSE_DELIVERY_UNKNOWN';
        throw error;
      }
    },
  });
}
export interface ReadResponseOptions<A extends Admission = Admission> {
  controller: SourceAdmissionController<A>;
  admission: A;
  renderOutcome(outcome: NoRunOutcome): unknown;
}
export type ReadResponse = Readonly<{ mode: 'suppressed'; outcome: NoRunOutcome; rendered: null }> |
  Readonly<{ mode: 'deterministic'; outcome: NoRunOutcome; rendered: RenderedOutput }>;
function samePending(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function zeroResultFailure(execution: Response['lifecycle']['domainExecution'], language: 'en' | 'he'): string {
  return language === 'he' ? execution === 'none'
    ? 'לא הצלחתי להכין תשובה מאומתת. נסה שוב מאוחר יותר.'
    : 'לא הצלחתי לאמת תוצאה סופית. ייתכן שהפעולה בוצעה; לא אבצע אותה שוב אוטומטית.'
    : execution === 'none' ? 'I could not prepare a verified response. Please try again later.'
      : 'I cannot verify a final outcome. The operation may have had effects; I will not repeat it automatically.';
}
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
      ? zeroResultFailure(response.lifecycle.domainExecution, language)
      : response.status === 'success'
        ? 'הפעולה דווחה כהצלחה, אך אין לי ניסוח מאומת לפרטיה. לא אבצע אותה שוב אוטומטית.'
        : 'לא הצלחתי לאמת תשובה מלאה על תוצאת הפעולה. ייתכן שהיו לה השפעות; לא אבצע אותה שוב אוטומטית.'
    : response.results.length === 0
      ? zeroResultFailure(response.lifecycle.domainExecution, language)
      : response.status === 'success'
        ? 'The operation was reported successful, but I cannot safely summarize its details. I will not repeat it automatically.'
        : 'I cannot verify a complete response about the operation. It may have had effects; I will not repeat it automatically.';
  const warnings = response.results.some(result => result.warnings.length) ? [language === 'he'
    ? 'דווחו אזהרות נוספות, אך איני יכול להציג את פרטיהן בבטחה.'
    : 'Additional warnings were reported, but I cannot safely summarize their details.'] : [];
  return validateRenderedOutput({ schemaVersion: 2, message: [base, ...warnings].join('\n') });
}
export function controlResponse(raw: unknown, options: ResponseOptions | DomainResponseOptions | ReadResponseOptions = {}) {
  if (plain(raw) && raw.kind === 'benson.no-run') {
    if (!('controller' in options)) fail('read_response_dependencies_unavailable');
    return controlReadResponse(raw, options);
  }
  if ('controller' in options) fail('response_language_invalid');
  if (plain(raw) && raw.schemaVersion === 4) return controlV3(validateResponseV4Envelope(raw), options);
  if (plain(raw) && raw.schemaVersion === 3) return controlV3(validateResponseV3Envelope(raw), options);
  const response = validateResponseEnvelope(raw);
  const language = options.language;
  if (language !== 'en' && language !== 'he') fail('response_language_invalid');
  const { now, timezone } = options;
  if (typeof now !== 'string' || !/^\d{4}-\d\d-\d\dT/u.test(now) || !Number.isFinite(Date.parse(now))) fail('response_clock_invalid');
  if (typeof timezone !== 'string' || !timezone.trim()) fail('response_timezone_invalid');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { return fail('response_timezone_invalid'); }
  let rendered: Presentation = { kind: 'unsupported', reason: 'not_single_reviewed_domain_result' };
  const single = response.results[0];
  if (response.results.length === 1 && single && response.lifecycle.failure === null && response.status === single.status && 'renderResult' in options && options.renderResult) {
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
/** Explicit v3 branch of the same Controller; no native lifetime or authority is minted here. */
function controlV3(response: DomainResponse, options: ResponseOptions | DomainResponseOptions) {
  assertDomainResponse(response, options);
  const { language, now, timezone } = options;
  if (language !== 'en' && language !== 'he') fail('response_language_invalid');
  if (typeof now !== 'string' || !/^\d{4}-\d\d-\d\dT/u.test(now) || !Number.isFinite(Date.parse(now))) fail('response_clock_invalid');
  if (typeof timezone !== 'string' || !timezone.trim()) fail('response_timezone_invalid');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { return fail('response_timezone_invalid'); }
  const segments = response.results.map(result => {
    if (typeof options.renderDomainResult !== 'function') fail('response_v3_renderer_unavailable');
    const presentation = synchronous(options.renderDomainResult(result, { language, now, timezone }), 'response_renderer_must_be_synchronous');
    if (!presentation || presentation.kind !== 'rendered' ||
      !isDeepStrictEqual(boundedCopy(presentation.pendingContext), boundedCopy(result.pendingContext))) fail('response_v3_presentation_unavailable');
    return validateRenderedOutput({ schemaVersion: 2, message: presentation.text }).message;
  });
  const ordinary = !segments.length && response.lifecycle.failure === null && response.lifecycle.domainExecution === 'none';
  let composed = segments.length === 1 ? segments[0] : segments.map((text, index) => `${index + 1}. ${text}`).join('\n\n');
  if (segments.length && response.lifecycle.failure !== null) composed = `${zeroResultFailure(response.lifecycle.domainExecution, language)}\n\n${composed}`;
  const modes = [response.responsePolicy.preferredMode, ...response.responsePolicy.allowedModes.filter(mode => mode !== response.responsePolicy.preferredMode)];
  for (const mode of modes) {
    let message: string | undefined;
    if (mode === 'pass_through' && response.messageCandidate?.language === language &&
      (ordinary || (segments.length > 0 && response.messageCandidate.text === composed))) message = response.messageCandidate.text;
    if ((mode === 'deterministic' || mode === 'safe_failure') && segments.length) message = composed;
    if (mode === 'safe_failure' && !segments.length) message = zeroResultFailure(response.lifecycle.domainExecution, language);
    if (message !== undefined) {
      const rendered = validateRenderedOutput({ schemaVersion: 2, message });
      assertDomainResponse(response, options);
      return freeze({ mode, rendered });
    }
  }
  return fail('response_mode_unavailable');
}
export function controlReadResponse<A extends Admission>(raw: unknown, options: ReadResponseOptions<A>): ReadResponse {
  if (typeof options?.controller?.validateOutcome !== 'function' || typeof options.controller.assertCurrent !== 'function' ||
    typeof options.renderOutcome !== 'function') fail('read_response_dependencies_unavailable');
  const { controller, admission, renderOutcome } = options;
  const outcome = synchronous(controller.validateOutcome(admission, raw), 'read_response_validator_must_be_synchronous');
  if (outcome.schemaVersion !== 2 && outcome.schemaVersion !== 3) fail('read_response_native_invocation_required');
  if (outcome.disposition === 'suppressed' || outcome.disposition === 'reasoning-required') {
    assertion(controller.assertCurrent(admission), 'source_authority_must_be_synchronous');
    return freeze({ mode: 'suppressed', outcome, rendered: null });
  }
  const rendered = validateRenderedOutput(synchronous(renderOutcome(outcome), 'read_response_renderer_must_be_synchronous'));
  assertion(controller.assertCurrent(admission), 'source_authority_must_be_synchronous');
  return freeze({ mode: 'deterministic', outcome, rendered });
}
