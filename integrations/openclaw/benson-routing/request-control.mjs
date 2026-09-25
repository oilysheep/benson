import { CONTROL_CONTRACT_VERSION, createTaskEnvelope } from "./envelope.mjs";

export const MAX_CLASSIFIER_REQUEST_BYTES = 8192;
const REASONS = new Set([
  "non_external", "command", "plugin_binding", "already_owned",
  "cancelled", "duplicate_or_recovery", "unsupported_input",
  "identity_unavailable", "non_main_owner", "empty_or_oversized",
]);
const FIELDS = ["schemaVersion", "kind", "reason", "requestId", "sessionKey", "request"];

function plain(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function identifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

// This validator cannot authenticate its caller. The host admission owner must
// supply this record; model text and channel payloads are never accepted here.
export function projectRequestAdmission(nativeAdmission) {
  if (!plain(nativeAdmission) || Object.keys(nativeAdmission).length !== FIELDS.length ||
      !FIELDS.every((field) => Object.hasOwn(nativeAdmission, field)) ||
      nativeAdmission.schemaVersion !== CONTROL_CONTRACT_VERSION) {
    throw new TypeError("admission_shape_or_version");
  }
  const { kind, reason, requestId, sessionKey, request } = nativeAdmission;
  if (kind === "candidate") {
    if (reason !== null || !identifier(requestId) || !identifier(sessionKey) ||
        typeof request !== "string" || !request.trim() ||
        Buffer.byteLength(request, "utf8") > MAX_CLASSIFIER_REQUEST_BYTES) {
      throw new TypeError("candidate_admission_invalid");
    }
    return Object.freeze({
      kind: "candidate",
      trusted: Object.freeze({ requestId, sessionKey }),
      taskEnvelope: createTaskEnvelope(request),
    });
  }
  if (!["main_only", "bypass"].includes(kind) || !REASONS.has(reason) ||
      request !== null || (requestId !== null && !identifier(requestId)) ||
      (sessionKey !== null && !identifier(sessionKey))) {
    throw new TypeError("blocked_admission_invalid");
  }
  return Object.freeze({ kind, reason });
}
