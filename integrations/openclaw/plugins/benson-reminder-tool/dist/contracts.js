import { isDeepStrictEqual } from 'node:util';
import canonicalRecipients from "../../../../../agents/reminder-service/config/recipients.json" with { type: "json" };
import { normalizeLegacyTaskResult, NATIVE_READ_OUTCOME_VERSION, RESPONSE_CONTRACT_VERSION } from "../../../benson-routing/envelope.mjs";
import { createSourceAdmissionController, NATIVE_READ_ADMISSION_VERSION } from "../../../benson-routing/request-control.mjs";
import { controlResponse } from "../../../benson-routing/response-control.mjs";
import { formatUserDatetime } from "../../../../../shared/benson-datetime.mjs";

const nonEmptyString = { type: "string", minLength: 1, pattern: "\\S" };

const explicitUserMetadata = {
  type: "object",
  additionalProperties: false,
  required: ["value", "evidenceQuote"],
  properties: {
    value: {
      ...nonEmptyString,
      description: "Calendar metadata value explicitly supplied by the user.",
    },
    evidenceQuote: {
      ...nonEmptyString,
      description: "Exact quote from the cited provenance evidence that explicitly supplies this value.",
    },
    evidenceId: {
      ...nonEmptyString,
      description: "Evidence item id from input.provenance; required for multi-turn provenance.",
    },
  },
};

function loadCanonicalIdentityContract() {
  const config = structuredClone(canonicalRecipients);
  if (!config || typeof config !== "object" || !Array.isArray(config.recipients)) {
    throw new Error("Canonical Reminder recipients config must contain recipients[]");
  }
  if (!Array.isArray(config.trustedRequesterIds) || config.trustedRequesterIds.length === 0) {
    throw new Error("Canonical Reminder recipients config must contain trustedRequesterIds[]");
  }

  const recipientIds = config.recipients.map((recipient) => {
    const id = typeof recipient?.id === "string" ? recipient.id.trim() : "";
    if (!id) throw new Error("Every canonical Reminder recipient must have a non-empty id");
    return id;
  });
  if (new Set(recipientIds).size !== recipientIds.length) {
    throw new Error("Canonical Reminder recipient ids must be unique");
  }

  const recipientById = new Map(config.recipients.map((recipient) => [recipient.id, recipient]));
  const trustedRequesterIds = config.trustedRequesterIds.map((rawId) => {
    const id = typeof rawId === "string" ? rawId.trim() : "";
    const recipient = recipientById.get(id);
    if (!id || !recipient || recipient.type !== "person") {
      throw new Error(`Trusted Reminder requester must be a canonical person id: ${id || "<empty>"}`);
    }
    return id;
  });
  if (new Set(trustedRequesterIds).size !== trustedRequesterIds.length) {
    throw new Error("Trusted Reminder requester ids must be unique");
  }

  const trustedPrivateRoutes = new Map();
  for (const id of trustedRequesterIds) {
    const recipient = recipientById.get(id);
    const to = typeof recipient.to === "string" ? recipient.to.trim() : "";
    if (recipient.channel !== "whatsapp" || !to || trustedPrivateRoutes.has(to)) {
      throw new Error(`Trusted Reminder requester must have a unique WhatsApp route: ${id}`);
    }
    trustedPrivateRoutes.set(to, id);
  }
  const accountId = typeof config.accountId === "string" ? config.accountId.trim() : "";
  if (!accountId) throw new Error("Canonical Reminder accountId must be non-empty");

  return {
    recipientIds: Object.freeze(recipientIds),
    trustedRequesterIds: Object.freeze(trustedRequesterIds),
    trustedPrivateRoutes,
    accountId,
  };
}

const identityContract = loadCanonicalIdentityContract();
export const CANONICAL_RECIPIENT_IDS = identityContract.recipientIds;
export const TRUSTED_REQUESTER_IDS = identityContract.trustedRequesterIds;

export function resolveReminderRuntimeRoute(toolContext) {
  const delivery = toolContext?.deliveryContext;
  if (delivery?.channel !== "whatsapp" || delivery.accountId !== identityContract.accountId) {
    return null;
  }
  const sourceId = typeof delivery.to === "string" ? delivery.to.trim() : "";
  const isGroup = sourceId.endsWith("@g.us");
  const sender = typeof toolContext.requesterSenderId === "string"
    ? toolContext.requesterSenderId.trim() : "";
  const requesterId = identityContract.trustedPrivateRoutes.get(isGroup ? sender : sourceId);
  if (!requesterId) return null;
  if (!isGroup && sender && sender !== sourceId) return null;
  return { requesterId, sourceType: isGroup ? "group" : "private", sourceId, senderId: sender || sourceId };
}

export function reminderSchemaForRuntimeRoute(definition, route) {
  const schema = structuredClone(definition.schema);
  if (definition.name === "benson_reminder_create") {
    schema.properties.input.properties.requesterId.enum = [route.requesterId];
    schema.properties.input.properties.sourceConversation.properties.type.enum = [route.sourceType];
    schema.properties.input.properties.sourceConversation.properties.id.enum = [route.sourceId];
  } else if (definition.name === "benson_reminder_create_plan") {
    const item = schema.properties.input.properties.items.items;
    item.properties.requesterId.enum = [route.requesterId];
    item.properties.sourceConversation.properties.type.enum = [route.sourceType];
    item.properties.sourceConversation.properties.id.enum = [route.sourceId];
  } else {
    schema.properties.requesterId.enum = [route.requesterId];
  }
  return schema;
}

// Main delegates intent. Identity, read authorization and discovery stay in
// this existing owner and the deterministic Reminder Service; no child Run.
export function createReminderTaskToolFactory({ jsonResult, validateJsonSchemaValue,
  runReminderService, clock = () => new Date() }) {
  if (![jsonResult, validateJsonSchemaValue, runReminderService].every(value => typeof value === 'function')) {
    throw new TypeError('reminder_task_dependencies_unavailable');
  }
  const definition = REMINDER_TOOL_DEFINITIONS.find(item => item.name === 'benson_reminder_list');
  return context => {
    if (context.agentId !== 'main' || typeof context.assertInvocationCurrent !== 'function') return null;
    return {
      name: 'reminder_task', label: 'Reminder task',
      description: 'Delegate a full Reminder list to its deterministic domain entry. No mutation or child Run.',
      parameters: { type: 'object', properties: { operation: { const: 'list' } },
        required: ['operation'], additionalProperties: false },
      executionMode: 'sequential',
      async execute(callId, request, signal) {
        if (!request || Object.getPrototypeOf(request) !== Object.prototype ||
            Reflect.ownKeys(request).length !== 1 ||
            Object.getOwnPropertyDescriptor(request, 'operation')?.value !== 'list') {
          throw new TypeError('reminder_task_intent_invalid');
        }
        const route = resolveReminderRuntimeRoute(context);
        if (!route) throw new TypeError('reminder_task_requester_untrusted');
        const controller = createSourceAdmissionController({
          invocation: { callId, domain: 'reminder', subject: route.requesterId },
          now: () => clock().getTime(),
          assertCurrent() { signal?.throwIfAborted(); return context.assertInvocationCurrent(); },
          assertDomainOutcome(outcome) {
            assertReminderListResult(outcome.evidence.facts);
            if (outcome.disposition !== (outcome.evidence.facts.status === 'success' ? 'handled' : 'failed') ||
                (outcome.disposition === 'failed' && outcome.error?.code !== outcome.evidence.facts.error.code)) {
              throw new TypeError('reminder_task_evidence_mismatch');
            }
          },
        });
        const admission = controller.admit({ schemaVersion: NATIVE_READ_ADMISSION_VERSION,
          kind: 'benson.source-input', domain: 'reminder', scope: 'read', request: JSON.stringify(request) });
        let facts;
        try {
          facts = await executeReminderTool(definition, { requesterId: route.requesterId }, signal, {
            validateJsonSchemaValue, runtimeRoute: route,
            runtimeSchema: reminderSchemaForRuntimeRoute(definition, route),
            runReminderService: (params, operationSignal) => {
              controller.assertCurrent(admission);
              return runReminderService(params, operationSignal);
            },
          });
          controller.assertCurrent(admission);
          assertReminderListResult(facts);
        } catch {
          controller.assertCurrent(admission);
          facts = { status: 'failure', operation: 'list', verified: false, warnings: [],
            error: { code: 'REMINDER_READ_UNAVAILABLE', message: 'Reminder list could not be verified', retryable: true } };
        }
        if (facts.status === 'failure') {
          // Discovery has no effects to reconstruct. Preserve the safe reason
          // code without transferring backend diagnostics to Main's context.
          facts = { status: 'failure', operation: 'list', verified: false, warnings: [],
            error: { code: facts.error.code, message: 'Reminder list could not be verified',
              retryable: facts.error.retryable === true } };
        }
        const response = controlResponse({
          schemaVersion: NATIVE_READ_OUTCOME_VERSION, kind: 'benson.no-run',
          admission: { authorityKind: admission.authority.kind, callId: admission.callId,
            domain: admission.domain, subject: admission.authority.subject },
          disposition: facts.status === 'success' ? 'handled' : 'failed',
          evidence: { ref: callId, observedAt: clock().toISOString(), freshness: 'fresh', facts },
          effects: { status: 'none', refs: [] }, reconciliation: { required: false, reason: null },
          notification: null, error: facts.status === 'failure' ? {
            code: facts.error.code, message: 'Reminder list could not be verified', retryable: facts.error.retryable === true,
          } : null,
        }, { controller, admission, renderOutcome: outcome => renderReminderListOutcome(outcome, clock()) });
        const result = jsonResult(response.outcome);
        result.content.push({ type: 'text', text: response.rendered.message });
        controller.assertCurrent(admission);
        return result;
      },
    };
  };
}

function assertReminderListResult(result) {
  if (!result || result.operation !== 'list' || !Array.isArray(result.warnings) ||
      !['success', 'failure'].includes(result.status)) throw new TypeError('reminder_list_invalid');
  if (result.status === 'failure') {
    if (result.verified === true || !result.error || typeof result.error.code !== 'string') {
      throw new TypeError('reminder_list_failure_invalid');
    }
    return;
  }
  if (result.verified !== true || result.error != null || !Array.isArray(result.matches) ||
      result.warnings.length !== 0 ||
      !Number.isSafeInteger(result.matchCount) || result.matchCount !== result.matches.length ||
      result.matches.some(item => !item || item.schemaVersion !== 4 ||
        typeof item.reminderId !== 'string' || !item.reminderId.trim() ||
        !['active', 'paused'].includes(item.status) || typeof item.content !== 'string' || !item.content.trim() ||
        !Array.isArray(item.schedules) || item.schedules.length === 0 ||
        item.schedules.some(schedule => !schedule || !['one-shot', 'recurring'].includes(schedule.type) ||
          typeof schedule.timezone !== 'string' ||
          (schedule.type === 'one-shot' ? typeof schedule.resolvedTime !== 'string' : typeof schedule.cron !== 'string'))) ||
      new Set(result.matches.map(item => item.reminderId)).size !== result.matches.length) {
    throw new TypeError('reminder_list_incomplete');
  }
}

function renderReminderListOutcome(outcome, now) {
  const facts = outcome.evidence.facts;
  const message = outcome.disposition !== 'handled'
    ? 'לא ניתן לאמת כעת את רשימת התזכורות. לא בוצע שינוי.'
    : facts.matchCount === 0 ? 'לא נמצאו תזכורות הנגישות לך.'
      : facts.matches.map((item, index) => `${index + 1}. ${item.content} (${item.status === 'active' ? 'פעילה' : 'מושהית'}); ${item.schedules.map(schedule =>
        schedule.type === 'one-shot' ? formatUserDatetime(schedule.resolvedTime, schedule.timezone, { now }) : 'לפי לוח זמנים חוזר').join('; ')}`).join('\n');
  return { schemaVersion: RESPONSE_CONTRACT_VERSION, message };
}

const canonicalRecipientId = {
  type: "string",
  enum: CANONICAL_RECIPIENT_IDS,
  description: "Canonical recipient id from the Reminder recipients configuration.",
};

const trustedRequesterId = {
  type: "string",
  enum: TRUSTED_REQUESTER_IDS,
  description: "Canonical trusted requester id resolved from runtime route context.",
};

const sourceConversation = {
  type: "object",
  additionalProperties: false,
  required: ["type", "id"],
  properties: {
    type: {
      type: "string",
      enum: ["private", "group"],
      description: "Trusted source conversation type.",
    },
    id: {
      ...nonEmptyString,
      description: "Trusted source conversation id from OpenClaw runtime context.",
    },
  },
};

const provenance = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion", "contextId", "revision", "createdAt", "expiresAt",
    "sourceConversation", "requesterId", "currentEvidenceId", "evidence", "fieldEvidence",
  ],
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    contextId: nonEmptyString,
    revision: { type: "integer", minimum: 1 },
    createdAt: nonEmptyString,
    expiresAt: nonEmptyString,
    sourceConversation,
    requesterId: trustedRequesterId,
    currentEvidenceId: nonEmptyString,
    evidence: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "text"],
        properties: { id: nonEmptyString, text: nonEmptyString },
      },
    },
    fieldEvidence: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "evidenceId", "quote"],
        properties: { field: nonEmptyString, evidenceId: nonEmptyString, quote: nonEmptyString },
      },
    },
  },
};

const createPlanProvenance = structuredClone(provenance);
createPlanProvenance.properties.fieldEvidence.items.properties.field = {
  type: "string",
  enum: [
    "content",
    "recipientIds",
    "schedule",
    "calendar.requested",
    "calendar.durationMinutes",
    "calendar.eventSchedule",
  ],
  description: "Exact create-plan semantic field. Use recipientIds only when a recipient differs from requesterId.",
};

const schedule = {
  type: "object",
  additionalProperties: false,
  required: ["type", "timezone"],
  properties: {
    type: {
      type: "string",
      enum: ["one-shot", "relative", "recurring"],
    },
    resolvedTime: {
      ...nonEmptyString,
      description: "RFC3339 time with offset; one-shot only.",
    },
    cron: {
      ...nonEmptyString,
      description: "Cron expression; recurring only.",
    },
    timezone: {
      ...nonEmptyString,
      description: "IANA timezone, normally Asia/Jerusalem.",
    },
    offset: {
      type: "object",
      additionalProperties: false,
      required: ["value", "unit"],
      properties: {
        value: { type: "integer" },
        unit: {
          type: "string",
          enum: ["seconds", "minutes", "hours", "days", "weeks"],
        },
      },
      description: "Relative offset; relative schedules only.",
    },
    reference: {
      type: "string",
      enum: ["existing", "request"],
      description: "Relative update reference; update only.",
    },
  },
};

const oneShotSchedule = {
  type: "object",
  additionalProperties: false,
  required: ["type", "resolvedTime", "timezone"],
  properties: {
    type: { type: "string", enum: ["one-shot"] },
    resolvedTime: {
      ...nonEmptyString,
      description: "RFC3339 one-shot time with offset.",
    },
    timezone: {
      ...nonEmptyString,
      description: "IANA timezone, normally Asia/Jerusalem.",
    },
  },
};

const calendar = {
  type: "object",
  additionalProperties: false,
  required: ["requested"],
  properties: {
    requested: { type: "boolean" },
    durationMinutes: { type: "integer", minimum: 1, maximum: 1440 },
    calendarId: { type: "string", enum: ["primary"] },
    eventSchedule: {
      ...schedule,
      description: "Independent one-shot Calendar event start; required when a multi-schedule Reminder plan requests Calendar.",
    },
    summary: {
      ...explicitUserMetadata,
      description: "Explicit user-supplied Calendar summary with grounding evidence; omit when absent.",
    },
    description: {
      ...explicitUserMetadata,
      description: "Explicit user-supplied Calendar description with grounding evidence; omit when absent.",
    },
    location: {
      ...explicitUserMetadata,
      description: "Explicit user-supplied Calendar location with grounding evidence; omit when absent.",
    },
  },
};

const createInput = {
  type: "object",
  additionalProperties: false,
  required: [
    "sourceConversation",
    "requesterId",
    "recipientIds",
    "content",
    "calendar",
  ],
  properties: {
    sourceConversation,
    requesterId: trustedRequesterId,
    recipientIds: {
      type: "array",
      minItems: 1,
      items: canonicalRecipientId,
      description: "Canonical recipient ids selected from the Reminder recipients configuration.",
    },
    content: { type: "string", minLength: 1, maxLength: 1000 },
    verbatimRequest: {
      ...nonEmptyString,
      description: "Exact current user request; required when optional Calendar metadata is supplied.",
    },
    provenance,
    schedule,
    schedules: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: schedule,
      description: "All Reminder delivery schedules in one atomic logical plan.",
    },
    calendar,
    notifyRecipients: {
      type: "boolean",
      description: "Whether secondary recipients receive lifecycle notifications.",
    },
  },
};

const createPlanCalendar = {
  type: "object",
  additionalProperties: false,
  required: ["requested", "durationMinutes", "eventSchedule"],
  properties: {
    requested: { type: "boolean", enum: [true] },
    durationMinutes: { type: "integer", minimum: 1, maximum: 1440 },
    calendarId: { type: "string", enum: ["primary"] },
    eventSchedule: {
      ...oneShotSchedule,
      description: "Independent one-shot Calendar event start for this plan item.",
    },
  },
};

const createPlanItem = {
  type: "object",
  additionalProperties: false,
  required: [
    "sourceConversation",
    "requesterId",
    "recipientIds",
    "content",
    "provenance",
    "schedule",
    "calendar",
  ],
  properties: {
    sourceConversation,
    requesterId: trustedRequesterId,
    recipientIds: {
      type: "array",
      minItems: 1,
      items: canonicalRecipientId,
      description: "Canonical recipient ids selected from the Reminder recipients configuration.",
    },
    content: { type: "string", minLength: 1, maxLength: 1000 },
    verbatimRequest: {
      ...nonEmptyString,
      description: "Exact current user request retained for audit only; optional Calendar metadata is not accepted by create_plan.",
    },
    provenance: createPlanProvenance,
    schedule: oneShotSchedule,
    calendar: createPlanCalendar,
    notifyRecipients: {
      type: "boolean",
      description: "Whether secondary recipients receive lifecycle notifications.",
    },
  },
};

const updateInput = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    recipientId: {
      ...canonicalRecipientId,
      description: "Only this recipient of a multi-recipient Reminder is changed; all others retain their verified state.",
    },
    content: { type: "string", minLength: 1, maxLength: 1000 },
    verbatimRequest: {
      ...nonEmptyString,
      description: "Exact current user request; required when optional Calendar metadata is supplied.",
    },
    schedule,
    calendar,
  },
};

const requesterId = trustedRequesterId;

const reminderId = {
  ...nonEmptyString,
  description: "Exact verified Reminder id.",
};

const createSchema = {
  type: "object",
  additionalProperties: false,
  required: ["input"],
  properties: { input: createInput },
};

const createPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["input"],
  properties: {
    input: {
      type: "object", additionalProperties: false, required: ["items"],
      properties: { items: { type: "array", minItems: 2, maxItems: 2, items: createPlanItem } },
    },
  },
};


const listSchema = {
  type: "object",
  additionalProperties: false,
  required: ["requesterId"],
  properties: {
    requesterId,
    recipient: canonicalRecipientId,
    enabled: { type: "boolean" },
  },
};

const findSchema = {
  type: "object",
  additionalProperties: false,
  required: ["requesterId"],
  properties: {
    requesterId,
    reminderId: { ...nonEmptyString, description: "Exact Reminder id filter." },
    jobId: { ...nonEmptyString, description: "Exact Automation job id filter." },
    recipient: canonicalRecipientId,
    text: { ...nonEmptyString, description: "Reminder content filter." },
    enabled: { type: "boolean" },
  },
};

const updateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reminderId", "requesterId", "input"],
  properties: { reminderId, requesterId, input: updateInput },
};

const lifecycleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reminderId", "requesterId"],
  properties: { reminderId, requesterId },
};

export const REMINDER_TOOL_DEFINITIONS = [
  {
    name: "benson_reminder_create",
    label: "Benson Reminder Create",
    description: "Create one Reminder through the deterministic Reminder Service.",
    operation: "create-intent",
    schema: createSchema,
  },
  {
    name: "benson_reminder_create_plan",
    label: "Benson Reminder Create Plan",
    description: "Atomically create two separate Reminder+Calendar pairs through one deterministic transaction.",
    operation: "create-intent",
    schema: createPlanSchema,
  },
  {
    name: "benson_reminder_list",
    label: "Benson Reminder List",
    description: "List every Reminder visible to the trusted requester.",
    operation: "list-reminders",
    schema: listSchema,
  },
  {
    name: "benson_reminder_find",
    label: "Benson Reminder Find",
    description: "Find Reminders using only supplied discovery filters.",
    operation: "find-reminders",
    schema: findSchema,
  },
  {
    name: "benson_reminder_update",
    label: "Benson Reminder Update",
    description: "Update one exact verified Reminder.",
    operation: "update-reminder",
    schema: updateSchema,
  },
  {
    name: "benson_reminder_pause",
    label: "Benson Reminder Pause",
    description: "Pause one exact verified Reminder.",
    operation: "pause-reminder",
    schema: lifecycleSchema,
  },
  {
    name: "benson_reminder_resume",
    label: "Benson Reminder Resume",
    description: "Resume one exact verified Reminder.",
    operation: "resume-reminder",
    schema: lifecycleSchema,
  },
  {
    name: "benson_reminder_delete",
    label: "Benson Reminder Delete",
    description: "Delete one exact verified Reminder.",
    operation: "delete-reminder",
    schema: lifecycleSchema,
  },
];

function requiredProvenanceFields(input) {
  const fields = ["content", "calendar.requested"];
  if (input.recipientIds.some((recipientId) => recipientId !== input.requesterId)) {
    fields.push("recipientIds");
  }
  if (Array.isArray(input.schedules)) {
    input.schedules.forEach((_value, index) => fields.push(`schedules[${index}]`));
  } else {
    fields.push("schedule");
  }
  if (input.calendar?.requested === true) {
    fields.push("calendar.durationMinutes");
    if (input.calendar.eventSchedule) fields.push("calendar.eventSchedule");
    for (const field of ["summary", "description", "location"]) {
      if (Object.hasOwn(input.calendar, field)) fields.push(`calendar.${field}`);
    }
  }
  return fields;
}

async function validateProvenance(input, { readCurrentUserText, readOriginalUserTurns, runtimeRoute }) {
  const value = input?.provenance;
  const requiresBundle = Array.isArray(input?.schedules)
    || ["summary", "description", "location"].some(
      (field) => typeof input?.calendar?.[field]?.evidenceId === "string",
    );
  if (!value) {
    if (requiresBundle) throw new Error("input.provenance is required for multi-turn or multi-schedule Reminder plans");
    return null;
  }
  if (value.requesterId !== input.requesterId
      || value.sourceConversation.type !== input.sourceConversation.type
      || value.sourceConversation.id !== input.sourceConversation.id) {
    throw new Error("Reminder provenance route does not match the trusted create request");
  }
  if (runtimeRoute && (value.requesterId !== runtimeRoute.requesterId
      || value.sourceConversation.type !== runtimeRoute.sourceType
      || value.sourceConversation.id !== runtimeRoute.sourceId)) {
    throw new Error("Reminder provenance does not match the trusted runtime route");
  }
  const createdAt = Date.parse(value.createdAt);
  const expiresAt = Date.parse(value.expiresAt);
  const now = Date.now();
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || createdAt >= expiresAt) {
    throw new Error("Reminder provenance timestamps are invalid");
  }
  if (expiresAt < now || createdAt > now + 300_000) {
    throw new Error("Reminder provenance is expired or not yet valid");
  }
  const evidence = new Map();
  for (const item of value.evidence) {
    if (evidence.has(item.id)) throw new Error(`duplicate Reminder provenance evidence id: ${item.id}`);
    evidence.set(item.id, item.text);
  }
  if (value.revision !== value.evidence.length
      || value.evidence.at(-1)?.id !== value.currentEvidenceId) {
    throw new Error("Reminder provenance revision or current evidence does not match the turn sequence");
  }
  const currentEvidence = evidence.get(value.currentEvidenceId);
  if (!currentEvidence) throw new Error("current Reminder provenance evidence is missing");
  if (typeof readCurrentUserText !== "function") {
    throw new Error("trusted current-request provenance is unavailable");
  }
  const currentUserText = await readCurrentUserText();
  if (typeof currentUserText !== "string" || [...evidence.values()].some(
    (text) => !currentUserText.includes(text),
  )) {
    throw new Error("Reminder provenance evidence is not grounded in the current task");
  }
  if (typeof readOriginalUserTurns !== "function") {
    throw new Error("trusted original-user provenance is unavailable");
  }
  const originalTurns = await readOriginalUserTurns();
  if (!Array.isArray(originalTurns) || originalTurns.length === 0) {
    throw new Error("original user turns are unavailable for Reminder provenance");
  }
  let nextTurnExclusive = originalTurns.length;
  let currentEvidenceTurn = -1;
  for (let evidenceIndex = value.evidence.length - 1; evidenceIndex >= 0; evidenceIndex -= 1) {
    const item = value.evidence[evidenceIndex];
    let matchedTurn = -1;
    for (let turnIndex = nextTurnExclusive - 1; turnIndex >= 0; turnIndex -= 1) {
      const turn = originalTurns[turnIndex];
      if (
        typeof turn?.text === "string"
        && turn.text.includes(item.text)
      ) {
        matchedTurn = turnIndex;
        break;
      }
    }
    if (matchedTurn < 0) throw new Error("Reminder provenance evidence is not in original user turns");
    if (evidenceIndex === value.evidence.length - 1) {
      currentEvidenceTurn = matchedTurn;
    }
    nextTurnExclusive = matchedTurn;
  }
  if (currentEvidenceTurn !== originalTurns.length - 1) {
    throw new Error("Reminder provenance does not end at the current original user turn");
  }
  const citations = new Map();
  for (const citation of value.fieldEvidence) {
    if (citations.has(citation.field)) throw new Error(`duplicate Reminder provenance field: ${citation.field}`);
    const text = evidence.get(citation.evidenceId);
    if (!text || !text.includes(citation.quote)) {
      throw new Error(`Reminder provenance field is not grounded: ${citation.field}`);
    }
    citations.set(citation.field, citation);
  }
  for (const field of requiredProvenanceFields(input)) {
    if (!citations.has(field)) throw new Error(`Reminder provenance is missing field evidence: ${field}`);
  }
  return { evidence, citations };
}

export async function executeReminderTool(
  definition,
  params,
  signal,
  { validateJsonSchemaValue, runReminderService, readCurrentUserText, readOriginalUserTurns, runtimeRoute, runtimeSchema },
) {
  const canonicalParams = params?.input?.calendar?.requested === false
    ? { ...params, input: { ...params.input, calendar: { requested: false } } }
    : params;
  const validation = validateJsonSchemaValue({
    schema: runtimeSchema ?? definition.schema,
    value: canonicalParams,
    cacheKey: `benson-reminder-tool:${definition.name}:${runtimeRoute?.requesterId ?? "static"}:${definition.name.startsWith("benson_reminder_create") ? runtimeRoute?.sourceId ?? "static" : "shared"}:v2`,
    applyDefaults: false,
  });
  if (!validation.ok) {
    const detail = validation.errors.map((error) => error.text).join("; ").slice(0, 512);
    throw new Error(`Invalid ${definition.name} arguments: ${detail}`);
  }
  const input = validation.value?.input;
  if (definition.name === "benson_reminder_create_plan") {
    for (const item of input.items) {
      if (!Object.hasOwn(item, "schedule") || Object.hasOwn(item, "schedules")) {
        throw new Error("plan items require exactly one input.schedule");
      }
      if (item.calendar.requested !== true || !item.provenance) {
        throw new Error("plan items require Calendar and provenance");
      }
      if (runtimeRoute && (item.requesterId !== runtimeRoute.requesterId
          || item.sourceConversation.type !== runtimeRoute.sourceType
          || item.sourceConversation.id !== runtimeRoute.sourceId)) {
        throw new Error("plan item does not match trusted runtime route");
      }
      const verified = await validateProvenance(item, {
        readCurrentUserText, readOriginalUserTurns, runtimeRoute,
      });
      for (const field of ["summary", "description", "location"]) {
        if (!Object.hasOwn(item.calendar, field)) continue;
        const metadata = item.calendar[field];
        const citation = verified.citations.get(`calendar.${field}`);
        if (!metadata.evidenceId || metadata.evidenceId !== citation?.evidenceId
            || metadata.evidenceQuote.trim() !== citation?.quote
            || !metadata.evidenceQuote.includes(metadata.value.trim())) {
          throw new Error(`calendar.${field} does not match its provenance citation`);
        }
      }
    }
    return runReminderService({ ...validation.value, operation: definition.operation }, signal);
  }
  if (definition.name === "benson_reminder_create"
      && Object.hasOwn(input, "schedule") === Object.hasOwn(input, "schedules")) {
    throw new Error("supply exactly one of input.schedule or input.schedules");
  }
  if (runtimeRoute) {
    const requesterId = input?.requesterId ?? validation.value?.requesterId;
    if (requesterId !== runtimeRoute.requesterId) {
      throw new Error("requesterId does not match trusted runtime route");
    }
    if (definition.name === "benson_reminder_create" && (
      input?.sourceConversation?.type !== runtimeRoute.sourceType
      || input?.sourceConversation?.id !== runtimeRoute.sourceId
    )) {
      throw new Error("sourceConversation does not match trusted runtime route");
    }
  }
  const validatedProvenance = definition.name === "benson_reminder_create"
    ? await validateProvenance(input, { readCurrentUserText, readOriginalUserTurns, runtimeRoute })
    : null;
  const calendarValue = input?.calendar;
  const metadataFields = ["summary", "description", "location"].filter(
    (field) => calendarValue && Object.hasOwn(calendarValue, field),
  );
  if (metadataFields.length > 0) {
    if (validatedProvenance) {
      for (const field of metadataFields) {
        const metadata = calendarValue[field];
        const citation = validatedProvenance.citations.get(`calendar.${field}`);
        if (!metadata.evidenceId || metadata.evidenceId !== citation?.evidenceId
            || metadata.evidenceQuote.trim() !== citation?.quote
            || !metadata.evidenceQuote.includes(metadata.value.trim())) {
          throw new Error(`calendar.${field} does not match its provenance citation`);
        }
      }
      return runReminderService(
        { ...validation.value, operation: definition.operation },
        signal,
      );
    }
    const verbatimRequest = input?.verbatimRequest?.trim();
    if (!verbatimRequest) {
      throw new Error("verbatimRequest is required for explicit Calendar metadata");
    }
    for (const field of metadataFields) {
      const metadata = calendarValue[field];
      const value = metadata.value.trim();
      const evidenceQuote = metadata.evidenceQuote.trim();
      if (!verbatimRequest.includes(evidenceQuote) || !evidenceQuote.includes(value)) {
        throw new Error(`calendar.${field} is not grounded in verbatimRequest`);
      }
    }
    if (typeof readCurrentUserText !== "function") {
      throw new Error("trusted current-request provenance is unavailable");
    }
    const currentUserText = await readCurrentUserText();
    if (typeof currentUserText !== "string" || !currentUserText.includes(verbatimRequest)) {
      throw new Error("verbatimRequest is not grounded in the current Reminder task");
    }
  }
  return runReminderService(
    { ...validation.value, operation: definition.operation },
    signal,
  );
}

// Staged S06 adapter. executeReminderTool is the existing authenticated tool
// path; this wrapper derives task facts only from its deterministic service
// result. It is not registered until native Completion Control is ready.
export async function executeNormalizedReminderTool(
  definition, params, signal, dependencies, trusted, messageCandidate = null,
) {
  if (typeof trusted?.taskId !== "string" || trusted.taskId.length < 1 ||
      trusted.taskId.length > 512 || /[\u0000-\u001f\u007f]/u.test(trusted.taskId)) {
    throw new Error("Trusted Reminder task identity is unavailable");
  }
  const result = await executeReminderTool(definition, params, signal, dependencies);
  return normalizeReminderServiceResult(definition, result, trusted, messageCandidate);
}

// Pure projection of the actual service result. Native Completion Control uses
// this same contract after checking the native tool call and child transcript.
export function normalizeReminderServiceResult(definition, result, trusted, messageCandidate = null) {
  const operations = {
    "create-intent": "create", "list-reminders": "list", "find-reminders": "find",
    "update-reminder": "update", "pause-reminder": "pause",
    "resume-reminder": "resume", "delete-reminder": "delete",
  };
  const operation = operations[definition?.operation];
  if (!operation) throw new Error("Reminder operation has no canonical mapping");
  if (typeof trusted?.taskId !== "string" || trusted.taskId.length < 1 ||
      trusted.taskId.length > 512 || /[\u0000-\u001f\u007f]/u.test(trusted.taskId)) {
    throw new Error("Trusted Reminder task identity is unavailable");
  }
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      result.operation !== operation || !["success", "failure"].includes(result.status)) {
    throw new Error("Reminder service result has no matching operation evidence");
  }
  const warnings = result.warnings ?? [];
  if (!Array.isArray(warnings)) throw new Error("Reminder service warnings are invalid");
  let verified = false;
  let data;
  if (result.status === "success") {
    if (result.error != null || result.verified === false) {
      throw new Error("Reminder success contradicts service verification");
    }
    if (operation === "list" || operation === "find") {
      if (result.verified !== true || !Array.isArray(result.matches) ||
          result.matchCount !== result.matches.length) {
        throw new Error("Reminder discovery is incomplete");
      }
      data = Object.fromEntries(Object.entries(result).filter(([key]) =>
        !["status", "operation", "verified", "warnings"].includes(key)));
    } else {
      if (result.transaction?.status !== "success" || result.transaction?.verified !== true ||
          !result.data || typeof result.data !== "object" || Array.isArray(result.data) ||
          !result.transport || !Array.isArray(result.transport.deliveries)) {
        throw new Error("Reminder transaction is unverified or incomplete");
      }
      data = Object.fromEntries(Object.entries(result).filter(([key]) =>
        !["status", "operation", "warnings", "error"].includes(key)));
    }
    verified = true;
  } else {
    if (!result.error || typeof result.error !== "object" || Array.isArray(result.error)) {
      throw new Error("Reminder failure has no structured error");
    }
    data = result;
  }
  return normalizeLegacyTaskResult({
    status: result.status, domain: "reminder", operation, verified, data,
    warnings, error: result.status === "failure" ? result.error : null,
    pendingContext: null,
  }, trusted, messageCandidate);
}


function completionText(message, allowThinking = false) {
  if (!Array.isArray(message?.content) || !message.content.every((part) =>
    part?.type === "text" && typeof part.text === "string" ||
    allowThinking && part?.type === "thinking")) return null;
  const text = message.content.filter((part) => part.type === "text");
  return text.length === 1 ? text[0].text : null;
}
function completionJson(message, allowThinking = false) {
  const text = completionText(message, allowThinking);
  if (typeof text !== "string" || text.length > 64_000) {
    throw new Error("Reminder completion text is unavailable or oversized");
  }
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Reminder completion is not an object");
  }
  return value;
}

// The active service tool remains the only operation owner. This validator
// reads native transcript facts; it never re-executes the Reminder mutation.
export async function normalizeReminderCompletion({ runId, parentSessionKey, runs, readMessages,
  completedRun = null, now = new Date() }, trusted, messageCandidate = null) {
  if (typeof runId !== "string" || !runId ||
      typeof parentSessionKey !== "string" || !parentSessionKey.startsWith("agent:main:")) {
    throw new Error("Native Reminder correlation is unavailable");
  }
  const matches = runs.filter((task) => task.runId === runId && task.runtime === "subagent" &&
    task.agentId === "reminder-service" && (task.status === "succeeded" ||
      task.status === "running" && completedRun?.runId === runId &&
      completedRun.childSessionKey === task.childSessionKey &&
      completedRun.execution?.status === "terminal" &&
      completedRun.execution?.outcome?.status === "ok") &&
    typeof task.childSessionKey === "string" &&
    task.childSessionKey.startsWith("agent:reminder-service:subagent:") &&
    Number.isSafeInteger(task.createdAt));
  const endedAt = matches[0]?.status === "running" ? completedRun?.execution?.endedAt : matches[0]?.endedAt;
  if (!Number.isSafeInteger(endedAt) || matches.length !== 1) throw new Error("Correlated Reminder task is unavailable");
  const [parent, child] = await Promise.all([
    readMessages({ agentId: "main", sessionKey: parentSessionKey }),
    readMessages({ agentId: "reminder-service", sessionKey: matches[0].childSessionKey }),
  ]);
  const inbound = parent.filter((entry) => entry.role === "user" &&
    (entry.message?.__openclaw?.senderIdentity || entry.message?.__openclaw?.senderId ||
      entry.message?.__openclaw?.transport) && Number.isSafeInteger(entry.message?.timestamp));
  const latest = inbound.at(-1)?.message.timestamp;
  if (!Number.isSafeInteger(latest) || matches[0].createdAt < latest ||
      endedAt < matches[0].createdAt || endedAt > now.getTime() + 30_000) {
    throw new Error("Reminder completion belongs to an earlier request");
  }
  const allowed = new Map(REMINDER_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]));
  const results = child.filter((entry) => entry.role === "toolResult" &&
    allowed.has(entry.message?.toolName));
  if (results.length !== 1) throw new Error("Reminder completion requires one deterministic tool result");
  const tool = results[0];
  const callId = tool.message.toolCallId;
  const calls = child.flatMap((entry) => entry.role === "assistant" ?
    (entry.message?.content ?? []).filter((part) => part?.type === "toolCall" &&
      allowed.has(part.name)).map((part) => ({ entry, part })) : []);
  if (calls.length !== 1 || calls[0].entry.seq >= tool.seq ||
      calls[0].part.id !== callId || calls[0].part.name !== tool.message.toolName ||
      tool.message.isError === true || typeof callId !== "string" || !callId) {
    throw new Error("Reminder native tool provenance is incomplete");
  }
  const service = completionJson(tool.message);
  if (tool.message.details && !isDeepStrictEqual(tool.message.details, service) &&
      tool.message.details.persistedDetailsTruncated !== true) {
    throw new Error("Reminder tool details differ from native result");
  }
  const finalEntry = child.at(-1);
  if (finalEntry?.role !== "assistant" || finalEntry.seq <= tool.seq ||
      finalEntry.message?.stopReason === "toolUse") {
    throw new Error("Reminder final completion is missing");
  }
  const final = completionJson(finalEntry.message, true);
  const authoritative = normalizeReminderServiceResult(allowed.get(tool.message.toolName),
    service, trusted, messageCandidate);
  const claimed = normalizeLegacyTaskResult(final, trusted, messageCandidate);
  if (!isDeepStrictEqual(claimed, authoritative)) {
    throw new Error("Reminder child completion differs from service truth");
  }
  return authoritative;
}
