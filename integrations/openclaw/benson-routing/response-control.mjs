import {
  RESPONSE_CONTRACT_VERSION,
  validateRenderedOutput,
  validateResponseEnvelope,
} from './envelope.mjs';
import { renderPresentation } from './presentation.mjs';

const LANGUAGES = new Set(['en', 'he']);
const RESULT_FIELDS = [
  'status', 'domain', 'operation', 'verified', 'data', 'warnings',
  'error', 'pendingContext',
];

function fail(code) { throw new TypeError(code); }

function legacyPresentationResult(result) {
  const projected = Object.fromEntries(RESULT_FIELDS.map((field) => [field, result[field]]));
  if (result.domain === 'jessica-vacuum') projected.schemaVersion = result.domainSchemaVersion;
  return projected;
}

function candidateAllowed(response, language, deterministic) {
  const candidate = response.messageCandidate;
  if (!candidate || candidate.language !== language) return false;
  if (response.results.length === 0) {
    // Main owns the semantics of ordinary conversation. There are no domain
    // effects or result facts for a candidate to conceal or contradict.
    return response.source.type === 'main' && response.status === 'success' &&
      response.lifecycle.domainExecution === 'none' && response.lifecycle.failure === null &&
      response.provenance.executionVerified === 'not_applicable';
  }
  // Domain pass-through is reviewed only for the exact deterministic wording.
  // Presence, schema validity, and an agent's own verification claim do not
  // establish factual coverage for arbitrary prose.
  return deterministic?.kind === 'rendered' &&
    deterministic.text === candidate.text &&
    JSON.stringify(deterministic.pendingContext) === JSON.stringify(response.pendingContext);
}

function boundedWarningDetails(response, language) {
  const warnings = response.results.flatMap((result) => result.warnings);
  if (warnings.length === 0) return [];
  // Unreviewed warning prose is never a safe user-facing fact, even if its
  // syntax is valid. Preserve the warning in the envelope for native recovery.
  return [language === 'he'
    ? 'דווחו אזהרות נוספות, אך איני יכול להציג את פרטיהן בבטחה.'
    : 'Additional warnings were reported, but I cannot safely summarize their details.'];
}

function safeFailure(response, language) {
  const warnings = boundedWarningDetails(response, language);
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
  return [base, ...warnings].join('\n');
}

/** Pure final response policy. OpenClaw owns transcript, transport and recovery. */
export function controlResponse(raw, { language, timezone, now } = {}) {
  const response = validateResponseEnvelope(raw);
  if (!LANGUAGES.has(language)) fail('response_language_invalid');
  if (typeof now !== 'string' || !/^\d{4}-\d\d-\d\dT/u.test(now) ||
      !Number.isFinite(Date.parse(now))) fail('response_clock_invalid');
  if (typeof timezone !== 'string' || !timezone.trim()) fail('response_timezone_invalid');
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); }
  catch { fail('response_timezone_invalid'); }
  const deterministic = response.results.length === 1 && response.lifecycle.failure === null &&
    response.status === response.results[0].status
    ? renderPresentation({ result: legacyPresentationResult(response.results[0]), language,
      timezone, now })
    : null;
  const policy = response.responsePolicy;
  const ordered = [policy.preferredMode,
    ...policy.allowedModes.filter((mode) => mode !== policy.preferredMode)];
  for (const mode of ordered) {
    if (mode === 'pass_through' && candidateAllowed(response, language, deterministic)) {
      return Object.freeze({ mode, rendered: validateRenderedOutput({
        schemaVersion: RESPONSE_CONTRACT_VERSION, message: response.messageCandidate.text,
      }) });
    }
    if (mode === 'deterministic' && deterministic?.kind === 'rendered' &&
        JSON.stringify(deterministic.pendingContext) === JSON.stringify(response.pendingContext)) {
      return Object.freeze({ mode, rendered: validateRenderedOutput({
        schemaVersion: RESPONSE_CONTRACT_VERSION, message: deterministic.text,
      }) });
    }
    if (mode === 'safe_failure') {
      return Object.freeze({ mode, rendered: validateRenderedOutput({
        schemaVersion: RESPONSE_CONTRACT_VERSION,
        message: safeFailure(response, language),
      }) });
    }
  }
  fail('response_mode_unavailable');
}
