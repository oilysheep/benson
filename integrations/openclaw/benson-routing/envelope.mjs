export const TASK_ENVELOPE_KIND = "benson.self-contained-request";
export const TASK_ENVELOPE_VERSION = 1;

const ENVELOPE_KEYS = new Set(["kind", "version", "request"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function createTaskEnvelope(request) {
  if (typeof request !== "string") {
    throw new TypeError("request_must_be_string");
  }

  return Object.freeze({
    kind: TASK_ENVELOPE_KIND,
    version: TASK_ENVELOPE_VERSION,
    request,
  });
}

export function formatTaskEnvelope(request) {
  return JSON.stringify(createTaskEnvelope(request));
}

export function parseTaskEnvelope(serialized) {
  if (typeof serialized !== "string") {
    throw new TypeError("envelope_must_be_string");
  }

  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new TypeError("invalid_envelope_json");
  }

  if (!isPlainObject(parsed)) {
    throw new TypeError("invalid_envelope_shape");
  }

  const keys = Object.keys(parsed);
  if (
    keys.length !== ENVELOPE_KEYS.size ||
    !keys.every((key) => ENVELOPE_KEYS.has(key)) ||
    parsed.kind !== TASK_ENVELOPE_KIND ||
    parsed.version !== TASK_ENVELOPE_VERSION ||
    typeof parsed.request !== "string"
  ) {
    throw new TypeError("invalid_envelope_shape");
  }

  return createTaskEnvelope(parsed.request);
}
