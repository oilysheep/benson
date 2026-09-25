const LANGUAGES = new Set(["en", "he"]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return record(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function frozen(value) {
  if (record(value) || Array.isArray(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

function unsupported(reason) {
  return frozen({ kind: "unsupported", reason });
}

function rendered(text, pendingContext = null) {
  return frozen({
    kind: "rendered",
    text,
    pendingContext: pendingContext === null ? null : structuredClone(pendingContext),
  });
}

function hasNoWarningsOrError(result) {
  return Array.isArray(result.warnings) && result.warnings.length === 0 &&
    result.error === null && result.pendingContext === null;
}

function renderJessica(result, language) {
  if (!exactKeys(result, [
    "schemaVersion",
    "status",
    "domain",
    "operation",
    "verified",
    "data",
    "warnings",
    "error",
    "pendingContext",
  ])) return unsupported("unsupported_result_shape");
  if (result.schemaVersion !== "1") return unsupported("unsupported_schema");

  if (result.status === "clarification_required") {
    if (language !== "he" || result.verified !== false || result.error !== null ||
        !exactKeys(result.data, ["question", "candidates"]) ||
        !nonempty(result.data.question) || !Array.isArray(result.data.candidates) ||
        !record(result.pendingContext)) {
      return unsupported("semantic_rendering_required");
    }
    return rendered(result.data.question, result.pendingContext);
  }

  if (result.status === "failure") {
    if (language === "en" && result.operation === "clean" && result.verified === false &&
        result.data === null && record(result.error) &&
        result.error.sideEffects === "possible" && result.error.retryMode === "reconcile") {
      return rendered(
        "I couldn't verify whether Jessica started cleaning. The command may have had an effect, so I won't retry it before checking the current state.",
      );
    }
    return unsupported("semantic_rendering_required");
  }

  if (result.status !== "success" || result.verified !== true || !record(result.data)) {
    return unsupported("unverified_result");
  }

  if (result.operation === "status" && language === "en" && hasNoWarningsOrError(result) &&
      result.data.kind === "status" && result.data.state === "docked" &&
      Number.isSafeInteger(result.data.batteryLevel) &&
      result.data.batteryLevel >= 0 && result.data.batteryLevel <= 100) {
    return rendered(`Jessica is docked with ${result.data.batteryLevel}% battery.`);
  }

  if (result.operation === "rooms" && language === "he" && hasNoWarningsOrError(result) &&
      result.data.kind === "rooms" && Array.isArray(result.data.rooms) &&
      result.data.rooms.length > 0 && result.data.rooms.every((room) =>
        record(room) && nonempty(room.label) && typeof room.enabled === "boolean")) {
    const rooms = result.data.rooms.map((room) =>
      `${room.label.trim()} (${room.enabled ? "פעיל" : "לא פעיל"})`);
    return rendered(`החדרים במפה: ${rooms.join(", ")}.`);
  }

  if (result.operation === "clean" && language === "he" && hasNoWarningsOrError(result) &&
      result.data.outcome === "started" && result.data.dispatch === "accepted" &&
      Array.isArray(result.data.rooms) && result.data.rooms.length === 1 &&
      nonempty(result.data.rooms[0])) {
    return rendered("הניקוי בחדר שביקשת התחיל.");
  }

  if (result.operation === "maintenance" && language === "en" &&
      result.data.kind === "maintenance" && Array.isArray(result.data.items) &&
      result.data.items.length === 1 &&
      result.data.items[0]?.name === "main_brush_remaining" &&
      Number.isFinite(result.data.items[0]?.value) && result.data.items[0]?.unit === "%" &&
      Array.isArray(result.warnings) && result.warnings.length === 1 &&
      result.warnings[0]?.code === "PARTIAL_HEALTH_DATA" &&
      result.warnings[0]?.message === "Dustbin sensor data is unavailable" &&
      result.error === null && result.pendingContext === null) {
    return rendered(
      `The main brush has ${result.data.items[0].value}% remaining. Warning: dustbin sensor data is unavailable.`,
    );
  }

  return unsupported("semantic_rendering_required");
}

function reminderDeliveries(result) {
  const deliveries = result?.data?.transport?.deliveries;
  return Array.isArray(deliveries) ? deliveries : [];
}

function renderReminder(result, language) {
  if (!exactKeys(result, [
    "status",
    "domain",
    "operation",
    "verified",
    "data",
    "warnings",
    "error",
    "pendingContext",
  ])) return unsupported("unsupported_result_shape");

  if (result.status === "success" && result.verified !== true) {
    return unsupported("unverified_result");
  }
  if (reminderDeliveries(result).length > 0) {
    return unsupported("native_delivery_required");
  }
  if (result.status === "clarification_required" || result.status === "failure") {
    return unsupported("semantic_rendering_required");
  }
  if (result.status !== "success" || !record(result.data) ||
      !Array.isArray(result.warnings) || result.warnings.length !== 0 ||
      result.error !== null || result.pendingContext !== null) {
    return unsupported("unsupported_result_shape");
  }

  if (result.operation === "find" && language === "he" &&
      result.data.matchCount === 0 && Array.isArray(result.data.matches) &&
      result.data.matches.length === 0) {
    return rendered("לא נמצאו תזכורות תואמות.");
  }

  if (result.operation === "delete" && language === "en" &&
      result.data.transaction?.status === "success" &&
      result.data.transaction?.verified === true &&
      result.data.record?.status === "deleted" &&
      nonempty(result.data.record?.content) && reminderDeliveries(result).length === 0) {
    return rendered(`The “${result.data.record.content.trim()}” reminder was deleted.`);
  }

  return unsupported("semantic_rendering_required");
}

export function renderPresentation(input) {
  if (!exactKeys(input, ["result", "language"]) || !LANGUAGES.has(input.language) ||
      !record(input.result)) {
    return unsupported("invalid_input");
  }
  if (input.result.domain === "jessica-vacuum") {
    return renderJessica(input.result, input.language);
  }
  if (input.result.domain === "reminder") {
    return renderReminder(input.result, input.language);
  }
  return unsupported("unsupported_result_shape");
}
