#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$(cd "$ROOT/../.." && pwd)"
MAIN_AGENTS="$PKG/main/AGENTS.md"
CORE="$ROOT/libexec/reminder-service-core"
TOOL="$ROOT/tools/reminder-service"
PLUGIN_DIR="$PKG/integrations/openclaw/plugins/benson-reminder-tool"
PLUGIN_RUNNER="$PLUGIN_DIR/dist/runner.js"
PLUGIN_INDEX="$PLUGIN_DIR/dist/index.js"
PLUGIN_CONTRACTS="$PLUGIN_DIR/dist/contracts.js"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

for file in AGENTS.md README.md lib/reminder_discovery.py libexec/reminder-service-core tools/reminder-service; do
  [[ -f "$ROOT/$file" ]] || fail "missing $file"
done
for file in "$PLUGIN_RUNNER" "$PLUGIN_INDEX" "$PLUGIN_CONTRACTS"; do
  [[ -f "$file" ]] || fail "missing Reminder plugin contract: $file"
done
for absent in \
  tools/reminder-create-for-main \
  tools/reminder-lifecycle-for-main \
  tools/reminder-result-for-main \
  lib/handoff_bundle.py \
  libexec/reminder-create-for-main-core \
  libexec/reminder-lifecycle-for-main-core \
  libexec/reminder-result-for-main-core
do
  [[ ! -e "$ROOT/$absent" ]] || fail "obsolete parallel transport is active: $absent"
done

python3 - "$CORE" "$ROOT/lib/reminder_discovery.py" "$TOOL" \
  "$MAIN_AGENTS" "$ROOT/AGENTS.md" "$PLUGIN_RUNNER" "$PLUGIN_INDEX" "$PLUGIN_CONTRACTS" <<'PY'
from pathlib import Path
import sys
core, discovery, tool, main, reminder, plugin_runner, plugin_index, plugin_contracts = [Path(p).read_text(encoding="utf-8") for p in sys.argv[1:]]
for p, text in zip(sys.argv[1:4], (core, discovery, tool)):
    compile(text, p, "exec")
assert '"automations", "list"' in core
assert '"automations", "add"' in core
assert 'state/reminders' not in core
assert 'REMINDER_REGISTRY_DIR' not in core
assert 'benson.reminder-calendar-link.v1' in core
assert '"createdBy"' in core
assert 'resolve_trusted_requester' in core
assert 'load_records()' in discovery
assert 'resolve_trusted_requester(args.requester, config)' in discovery
assert 'requester_can_access_record(record, requester_id)' in discovery
assert 'reminder-create-for-main' not in tool
assert 'context="isolated"' in main
assert 'sessions_yield' in main
assert 'A correlated Reminder child failure is terminal' in main
assert 'custom handoff id' in main
assert 'tools/reminder-service`' in reminder
assert 'native child completion' in reminder
assert 'reminder-result-for-main' not in reminder
assert 'toolContext.agentId !== "reminder-service"' in plugin_index
assert 'validateJsonSchemaValue' in plugin_index
assert 'runReminderService' in plugin_index
assert 'getConversationSession' in plugin_index
assert 'readOriginalUserTurns' in plugin_index
assert 'entry.message.__openclaw?.transport?.channel === "whatsapp"' in plugin_index
assert 'entry.message.__openclaw?.senderId === runtimeRoute.senderId' in plugin_index
for name in (
    'benson_reminder_create', 'benson_reminder_list', 'benson_reminder_find',
    'benson_reminder_update', 'benson_reminder_pause', 'benson_reminder_resume',
    'benson_reminder_delete',
):
    assert name in plugin_contracts
assert 'benson_reminder_service' not in plugin_index
assert 'benson_reminder_service' not in plugin_contracts
assert 'calendar_event_' not in plugin_index
assert 'calendar_event_' not in plugin_contracts
assert 'gog' not in plugin_index.lower()
assert 'gog' not in plugin_contracts.lower()
assert '../../../../../agents/reminder-service/tools/reminder-service' in plugin_runner
print('STATIC_NATIVE_FIRST_CONTRACT=PASS')
PY

OPENCLAW_CLI="${OPENCLAW_CLI:-/home/oa/.npm-global/bin/openclaw}"
[[ -x "$OPENCLAW_CLI" ]] || fail "missing OpenClaw CLI: $OPENCLAW_CLI"
OPENCLAW_ENTRY="$(readlink -f "$OPENCLAW_CLI")"
OPENCLAW_PKG="$(dirname "$OPENCLAW_ENTRY")"
OPENCLAW_SCHEMA_RUNTIME="$OPENCLAW_PKG/dist/plugin-sdk/json-schema-runtime.js"
[[ -f "$OPENCLAW_SCHEMA_RUNTIME" ]] || fail "missing OpenClaw native JSON-schema runtime"
OPENCLAW_TOOL_VALIDATOR="$OPENCLAW_PKG/dist/validation-BDzVDnTs.mjs"
[[ -f "$OPENCLAW_TOOL_VALIDATOR" ]] || fail "missing OpenClaw native tool argument validator"

node --input-type=module - "$TOOL" "$PLUGIN_RUNNER" "$PLUGIN_CONTRACTS" "$ROOT/config/recipients.json" "$OPENCLAW_SCHEMA_RUNTIME" "$OPENCLAW_TOOL_VALIDATOR" <<'JS'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const canonicalTool = process.argv[2];
const runnerPath = process.argv[3];
const contractsPath = process.argv[4];
const recipientsConfigPath = process.argv[5];
const schemaRuntimePath = process.argv[6];
const toolValidatorPath = process.argv[7];
const runner = await import(pathToFileURL(runnerPath));
const contracts = await import(pathToFileURL(contractsPath));
const { validateJsonSchemaValue } = await import(pathToFileURL(schemaRuntimePath));
const recipientsConfig = JSON.parse(readFileSync(recipientsConfigPath, "utf8"));
const { t: validateToolArguments } = await import(pathToFileURL(toolValidatorPath));
assert.equal(runner.REMINDER_SERVICE_PATH, canonicalTool);

const definitions = new Map(
  contracts.REMINDER_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]),
);
assert.deepEqual(
  contracts.CANONICAL_RECIPIENT_IDS,
  recipientsConfig.recipients.map((recipient) => recipient.id),
);
assert.deepEqual(
  contracts.TRUSTED_REQUESTER_IDS,
  recipientsConfig.trustedRequesterIds,
);
assert.deepEqual(
  [...definitions.keys()],
  [
    "benson_reminder_create",
    "benson_reminder_create_plan",
    "benson_reminder_list",
    "benson_reminder_find",
    "benson_reminder_update",
    "benson_reminder_pause",
    "benson_reminder_resume",
    "benson_reminder_delete",
  ],
);

const validParameters = {
  benson_reminder_create: {
    input: {
      sourceConversation: { type: "private", id: "+972500000001" },
      requesterId: "oren",
      recipientIds: ["oren"],
      content: "contract create",
      schedule: {
        type: "one-shot",
        resolvedTime: "2099-02-03T11:22:17+02:00",
        timezone: "Asia/Jerusalem",
      },
      calendar: { requested: false },
    },
  },
  benson_reminder_list: { requesterId: "oren", enabled: true },
  benson_reminder_find: { requesterId: "oren", text: "contract" },
  benson_reminder_update: {
    reminderId: "rem-contract",
    requesterId: "oren",
    input: { content: "updated" },
  },
  benson_reminder_pause: { reminderId: "rem-contract", requesterId: "oren" },
  benson_reminder_resume: { reminderId: "rem-contract", requesterId: "oren" },
  benson_reminder_delete: { reminderId: "rem-contract", requesterId: "oren" },
};
const contractPlanEvidence = "Create two separate Reminder and Calendar pairs for thirty minutes.";
validParameters.benson_reminder_create_plan = { input: { items: [0, 1].map((index) => {
  const schedule = {
    type: "one-shot",
    resolvedTime: `2099-02-0${index + 3}T11:22:17+02:00`,
    timezone: "Asia/Jerusalem",
  };
  return {
    ...structuredClone(validParameters.benson_reminder_create.input),
    content: `plan item ${index}`,
    schedule,
    calendar: { requested: true, durationMinutes: 30, eventSchedule: { ...schedule } },
    provenance: {
      schemaVersion: 1,
      contextId: `contract-plan-${index}`,
      revision: 1,
      createdAt: "2098-01-01T00:00:00Z",
      expiresAt: "2099-12-31T23:59:59Z",
      sourceConversation: { type: "private", id: "+972500000001" },
      requesterId: "oren",
      currentEvidenceId: "turn-1",
      evidence: [{ id: "turn-1", text: contractPlanEvidence }],
      fieldEvidence: [
        "content", "recipientIds", "schedule", "calendar.requested",
        "calendar.durationMinutes", "calendar.eventSchedule",
      ].map((field) => ({ field, evidenceId: "turn-1", quote: contractPlanEvidence })),
    },
  };
}) } };


for (const requesterId of ["oren", "ilana", "amit"]) {
  const sourceId = recipientsConfig.recipients.find((item) => item.id === requesterId).to;
  const route = contracts.resolveReminderRuntimeRoute({
    deliveryContext: { channel: "whatsapp", accountId: recipientsConfig.accountId, to: sourceId },
    requesterSenderId: sourceId,
  });
  assert.deepEqual(route, { requesterId, sourceType: "private", sourceId, senderId: sourceId });
  for (const definition of definitions.values()) {
    const schema = contracts.reminderSchemaForRuntimeRoute(definition, route);
    const own = structuredClone(validParameters[definition.name]);
    if (definition.name === "benson_reminder_create") {
      own.input.requesterId = requesterId;
      own.input.recipientIds = [requesterId];
      own.input.sourceConversation.id = sourceId;
    } else if (definition.name === "benson_reminder_create_plan") {
      for (const item of own.input.items) {
        item.requesterId = requesterId;
        item.recipientIds = [requesterId];
        item.sourceConversation.id = sourceId;
        item.provenance.requesterId = requesterId;
        item.provenance.sourceConversation.id = sourceId;
      }
    } else {
      own.requesterId = requesterId;
    }
    assert.equal(validateJsonSchemaValue({
      schema, value: own, cacheKey: `test:route:${requesterId}:${definition.name}`, applyDefaults: false,
    }).ok, true);
    const switched = structuredClone(own);
    if (definition.name === "benson_reminder_create") switched.input.requesterId = "oren" === requesterId ? "ilana" : "oren";
    else if (definition.name === "benson_reminder_create_plan") switched.input.items[0].requesterId = "oren" === requesterId ? "ilana" : "oren";
    else switched.requesterId = "oren" === requesterId ? "ilana" : "oren";
    assert.equal(validateJsonSchemaValue({
      schema, value: switched, cacheKey: `test:route:switched:${requesterId}:${definition.name}`, applyDefaults: false,
    }).ok, false);
    if (definition.name === "benson_reminder_create" || definition.name === "benson_reminder_create_plan") {
      const switchedSource = structuredClone(own);
      const target = definition.name === "benson_reminder_create" ? switchedSource.input : switchedSource.input.items[0];
      target.sourceConversation.id = "+972000000000";
      assert.equal(validateJsonSchemaValue({
        schema, value: switchedSource, cacheKey: `test:route:source:${requesterId}`, applyDefaults: false,
      }).ok, false);
    }
  }
}
for (const deliveryContext of [
  { channel: "whatsapp", accountId: "wrong", to: recipientsConfig.recipients[0].to },
  { channel: "whatsapp", accountId: recipientsConfig.accountId, to: "+972000000000" },
  { channel: "telegram", accountId: recipientsConfig.accountId, to: recipientsConfig.recipients[0].to },
]) {
  assert.equal(contracts.resolveReminderRuntimeRoute({ deliveryContext }), null);
}
const groupRoute = contracts.resolveReminderRuntimeRoute({
  deliveryContext: { channel: "whatsapp", accountId: recipientsConfig.accountId,
    to: recipientsConfig.recipients.find((item) => item.id === "family").to },
  requesterSenderId: recipientsConfig.recipients.find((item) => item.id === "ilana").to,
});
assert.equal(groupRoute.requesterId, "ilana");
assert.equal(groupRoute.sourceType, "group");
assert.equal(contracts.resolveReminderRuntimeRoute({
  deliveryContext: { channel: "whatsapp", accountId: recipientsConfig.accountId, to: groupRoute.sourceId },
}), null);
console.log("TRUSTED_RUNTIME_ROUTE_SCHEMA_BOUNDARY=PASS");

for (const [name, params] of Object.entries(validParameters)) {
  const definition = definitions.get(name);
  const result = validateJsonSchemaValue({
    schema: definition.schema,
    value: params,
    cacheKey: `test:${name}`,
    applyDefaults: false,
  });
  assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`);
  const operationOverride = validateJsonSchemaValue({
    schema: definition.schema,
    value: { ...params, operation: "delete-reminder" },
    cacheKey: `test:${name}:operation-override`,
    applyDefaults: false,
  });
  assert.equal(operationOverride.ok, false, `${name} accepted operation override`);
}

for (const recipient of contracts.CANONICAL_RECIPIENT_IDS) {
  const result = validateJsonSchemaValue({
    schema: definitions.get("benson_reminder_find").schema,
    value: { requesterId: "oren", recipient },
    cacheKey: `test:find:recipient:${recipient}`,
    applyDefaults: false,
  });
  assert.equal(result.ok, true, `canonical recipient rejected: ${recipient}`);
}

for (const requesterId of contracts.TRUSTED_REQUESTER_IDS) {
  const result = validateJsonSchemaValue({
    schema: definitions.get("benson_reminder_list").schema,
    value: { requesterId },
    cacheKey: `test:list:requester:${requesterId}`,
    applyDefaults: false,
  });
  assert.equal(result.ok, true, `trusted requester rejected: ${requesterId}`);
}

const findDefinition = definitions.get("benson_reminder_find");
for (const field of ["reminderId", "jobId", "text"]) {
  assert.equal(validateJsonSchemaValue({
    schema: findDefinition.schema,
    value: { requesterId: "oren", [field]: " \t " },
    cacheKey: `test:find:whitespace:${field}`, applyDefaults: false,
  }).ok, false, `whitespace-only ${field} passed schema`);
}
assert.deepEqual(runner.buildArgv({ operation: "find-reminders", requesterId: "oren",
  jobId: "  job-contract  ", text: "  coffee  " }),
  ["find-reminders", "--requester", "oren", "--job-id", "job-contract", "--text", "coffee"]);
assert.throws(() => runner.buildArgv({ operation: "find-reminders", requesterId: "oren",
  jobId: " \t " }), /jobId must be a non-empty string/);
console.log("OPTIONAL_FIND_FILTERS_NON_WHITESPACE=PASS");
let identityBoundaryRunnerCalls = 0;
await assert.rejects(
  () => contracts.executeReminderTool(
    findDefinition,
    { requesterId: "oren", text: "contract", recipient: "invented-recipient" },
    undefined,
    {
      validateJsonSchemaValue,
      runReminderService: async () => {
        identityBoundaryRunnerCalls += 1;
        return { status: "unexpected" };
      },
    },
  ),
  /must be equal to one of the allowed values/,
);
assert.equal(identityBoundaryRunnerCalls, 0);

for (const [name, params] of Object.entries({
  benson_reminder_create: {
    ...validParameters.benson_reminder_create,
    input: { ...validParameters.benson_reminder_create.input, recipientIds: ["invented-recipient"] },
  },
  benson_reminder_list: { requesterId: "invented-requester" },
  benson_reminder_find: { requesterId: "oren", recipient: "invented-recipient" },
  benson_reminder_update: {
    ...validParameters.benson_reminder_update,
    requesterId: "invented-requester",
  },
  benson_reminder_pause: { reminderId: "rem-contract", requesterId: "invented-requester" },
  benson_reminder_resume: { reminderId: "rem-contract", requesterId: "invented-requester" },
  benson_reminder_delete: { reminderId: "rem-contract", requesterId: "invented-requester" },
})) {
  const result = validateJsonSchemaValue({
    schema: definitions.get(name).schema,
    value: params,
    cacheKey: `test:${name}:invented-identity`,
    applyDefaults: false,
  });
  assert.equal(result.ok, false, `${name} accepted an invented identity`);
}
console.log("CANONICAL_IDENTITY_SCHEMA_BOUNDARY=PASS");

const createDefinition = definitions.get("benson_reminder_create");
const ilanasRoute = contracts.resolveReminderRuntimeRoute({
  deliveryContext: { channel: "whatsapp", accountId: recipientsConfig.accountId,
    to: recipientsConfig.recipients.find((item) => item.id === "ilana").to },
});
let noCalendarForwarded;
await contracts.executeReminderTool(createDefinition, {
  input: {
    ...validParameters.benson_reminder_create.input,
    requesterId: "ilana", recipientIds: ["ilana"],
    sourceConversation: { type: "private", id: ilanasRoute.sourceId },
    calendar: {
      requested: false, durationMinutes: 30, calendarId: "primary",
      summary: { value: "unused", evidenceQuote: "unrelated" },
      description: { value: "unused", evidenceQuote: "unrelated" },
      location: { value: "unused", evidenceQuote: "unrelated" },
    },
  },
}, undefined, {
  validateJsonSchemaValue,
  runtimeRoute: ilanasRoute,
  runtimeSchema: contracts.reminderSchemaForRuntimeRoute(createDefinition, ilanasRoute),
  runReminderService: async (params) => { noCalendarForwarded = params; return { status: "success" }; },
});
assert.deepEqual(noCalendarForwarded.input.calendar, { requested: false });
console.log("NON_CALENDAR_METADATA_IGNORED=PASS");
const calendarCreate = {
  ...validParameters.benson_reminder_create,
  input: {
    ...validParameters.benson_reminder_create.input,
    calendar: { requested: true, durationMinutes: 20 },
  },
};
for (const requesterId of ["oren", "ilana", "amit"]) {
  const params = {
    ...calendarCreate,
    input: {
      ...calendarCreate.input,
      requesterId,
      recipientIds: [requesterId],
    },
  };
  const result = validateJsonSchemaValue({
    schema: createDefinition.schema,
    value: params,
    cacheKey: `test:create:calendar:no-summary:${requesterId}`,
    applyDefaults: false,
  });
  assert.equal(result.ok, true, `${requesterId}: ${JSON.stringify(result)}`);
  assert.equal(Object.hasOwn(params.input.calendar, "summary"), false);
}
const explicitSummary = {
  ...calendarCreate,
  input: {
    ...calendarCreate.input,
    verbatimRequest: "Set summary Explicit Calendar summary, description Explicit Calendar description, location Explicit Calendar location.",
    calendar: {
      ...calendarCreate.input.calendar,
      summary: {
        value: "Explicit Calendar summary",
        evidenceQuote: "summary Explicit Calendar summary",
      },
      description: {
        value: "Explicit Calendar description",
        evidenceQuote: "description Explicit Calendar description",
      },
      location: {
        value: "Explicit Calendar location",
        evidenceQuote: "location Explicit Calendar location",
      },
    },
  },
};
assert.equal(validateJsonSchemaValue({
  schema: createDefinition.schema,
  value: explicitSummary,
  cacheKey: "test:create:calendar:explicit-summary",
  applyDefaults: false,
}).ok, true);
let explicitForwarded;
await contracts.executeReminderTool(
  createDefinition,
  explicitSummary,
  undefined,
  {
    validateJsonSchemaValue,
    readCurrentUserText: async () => `Task with verbatim request: ${explicitSummary.input.verbatimRequest}`,
    runReminderService: async (params) => {
      explicitForwarded = params;
      return { status: "success" };
    },
  },
);
for (const field of ["summary", "description", "location"]) {
  assert.deepEqual(explicitForwarded.input.calendar[field], explicitSummary.input.calendar[field]);
}
const inventedMetadata = {
  ...calendarCreate,
  input: {
    ...calendarCreate.input,
    verbatimRequest: "Create a calendar event for the reminder.",
    calendar: {
      ...calendarCreate.input.calendar,
      location: { value: "/", evidenceQuote: "/" },
    },
  },
};
let inventedRunnerCalls = 0;
await assert.rejects(
  () => contracts.executeReminderTool(
    createDefinition,
    inventedMetadata,
    undefined,
    {
      validateJsonSchemaValue,
      readCurrentUserText: async () => "Create a calendar event for the reminder.",
      runReminderService: async () => {
        inventedRunnerCalls += 1;
        return { status: "unexpected" };
      },
    },
  ),
  /not grounded/,
);
assert.equal(inventedRunnerCalls, 0);
for (const field of ["summary", "description", "location"]) {
  const invalid = {
    ...calendarCreate,
    input: {
      ...calendarCreate.input,
      calendar: { ...calendarCreate.input.calendar, [field]: "" },
    },
  };
  assert.equal(validateJsonSchemaValue({
    schema: createDefinition.schema,
    value: invalid,
    cacheKey: `test:create:calendar:empty-${field}`,
    applyDefaults: false,
  }).ok, false, `empty calendar.${field} passed schema validation`);

  for (const metadata of [
    { value: "", evidenceQuote: "explicit value" },
    { value: "explicit value", evidenceQuote: "" },
  ]) {
    const invalidProvenance = {
      ...calendarCreate,
      input: {
        ...calendarCreate.input,
        verbatimRequest: "explicit value",
        calendar: { ...calendarCreate.input.calendar, [field]: metadata },
      },
    };
    assert.equal(validateJsonSchemaValue({
      schema: createDefinition.schema,
      value: invalidProvenance,
      cacheKey: `test:create:calendar:empty-provenance-${field}-${metadata.value.length}`,
      applyDefaults: false,
    }).ok, false, `empty provenance for calendar.${field} passed schema validation`);
  }
}
console.log("CALENDAR_OPTIONAL_METADATA_SCHEMA=PASS");

const evidenceTurns = [
  { id: "turn-1", text: "Family plan at Menora at 21:00" },
  { id: "turn-2", text: "For Amit and Oren" },
  { id: "turn-3", text: "Remind at 10:00 and 18:00" },
  { id: "turn-4", text: "Also in Calendar" },
  { id: "turn-5", text: "One hour" },
];
const originalTurns = evidenceTurns.map((turn) => ({ text: turn.text }));
const evidenceText = evidenceTurns.map((turn) => turn.text).join("\n");
const now = Date.now();
const planInput = {
  sourceConversation: { type: "private", id: ilanasRoute.sourceId },
  requesterId: "ilana", recipientIds: ["amit", "oren"], content: "Family plan",
  schedules: [
    { type: "one-shot", resolvedTime: "2099-03-01T10:00:00+02:00", timezone: "Asia/Jerusalem" },
    { type: "one-shot", resolvedTime: "2099-03-01T18:00:00+02:00", timezone: "Asia/Jerusalem" },
  ],
  calendar: {
    requested: true, durationMinutes: 60,
    eventSchedule: { type: "one-shot", resolvedTime: "2099-03-01T21:00:00+02:00", timezone: "Asia/Jerusalem" },
    location: { value: "Menora", evidenceQuote: evidenceTurns[0].text, evidenceId: "turn-1" },
  },
  provenance: {
    schemaVersion: 1, contextId: "ctx-contract", revision: evidenceTurns.length,
    createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(),
    sourceConversation: { type: "private", id: ilanasRoute.sourceId }, requesterId: "ilana",
    currentEvidenceId: "turn-5", evidence: evidenceTurns,
    fieldEvidence: [
      ["content", 0], ["calendar.eventSchedule", 0], ["calendar.location", 0],
      ["recipientIds", 1], ["schedules[0]", 2], ["schedules[1]", 2],
      ["calendar.requested", 3], ["calendar.durationMinutes", 4],
    ].map(([field, index]) => ({ field, evidenceId: evidenceTurns[index].id,
      quote: evidenceTurns[index].text })),
  },
};
const planParams = { input: planInput };
const planSchema = contracts.reminderSchemaForRuntimeRoute(createDefinition, ilanasRoute);
assert.equal(validateJsonSchemaValue({ schema: planSchema, value: planParams,
  cacheKey: "test:create:multi-turn-plan", applyDefaults: false }).ok, true);
assert.equal(Object.hasOwn(planSchema.properties.input, "anyOf"), false);
for (const [label, params, schema] of [
  ["single", calendarCreate, contracts.reminderSchemaForRuntimeRoute(createDefinition, {
    requesterId: calendarCreate.input.requesterId,
    sourceType: calendarCreate.input.sourceConversation.type,
    sourceId: calendarCreate.input.sourceConversation.id,
  })],
  ["plan", planParams, planSchema],
]) {
  assert.doesNotThrow(() => validateToolArguments(
    { name: createDefinition.name, parameters: schema },
    { name: createDefinition.name, arguments: params },
  ), `native create admission rejected ${label}`);
}
const pairDefinition = definitions.get("benson_reminder_create_plan");
const pairItems = planInput.schedules.map((schedule, index) => {
  const item = structuredClone(planInput);
  delete item.schedules;
  delete item.calendar.location;
  item.schedule = schedule;
  item.calendar.eventSchedule = { ...schedule };
  item.provenance.fieldEvidence = item.provenance.fieldEvidence
    .filter((citation) => !citation.field.startsWith("schedules[")
      && citation.field !== "calendar.location")
    .concat({ field: "schedule", evidenceId: evidenceTurns[2].id, quote: evidenceTurns[2].text });
  item.provenance.contextId = `ctx-pair-${index}`;
  return item;
});
const pairParams = { input: { items: pairItems } };
const pairSchema = contracts.reminderSchemaForRuntimeRoute(pairDefinition, ilanasRoute);
assert.doesNotThrow(() => validateToolArguments(
  { name: pairDefinition.name, parameters: pairSchema },
  { name: pairDefinition.name, arguments: pairParams },
));
let pairRunnerCalls = 0;
await contracts.executeReminderTool(pairDefinition, pairParams, undefined, {
  validateJsonSchemaValue, runtimeRoute: ilanasRoute, runtimeSchema: pairSchema,
  readCurrentUserText: async () => `Current answer: ${evidenceText}`,
  readOriginalUserTurns: async () => originalTurns,
  runReminderService: async (params) => {
    pairRunnerCalls += 1;
    assert.equal(params.operation, "create-intent");
    assert.equal(params.input.items.length, 2);
    return { status: "success" };
  },
});
assert.equal(pairRunnerCalls, 1);
for (const invalid of ["foreign-route", "missing-provenance"]) {
  const params = structuredClone(pairParams);
  if (invalid === "foreign-route") params.input.items[1].requesterId = "oren";
  else delete params.input.items[1].provenance;
  await assert.rejects(() => contracts.executeReminderTool(pairDefinition, params, undefined, {
    validateJsonSchemaValue, runtimeRoute: ilanasRoute, runtimeSchema: pairSchema,
    readCurrentUserText: async () => `Current answer: ${evidenceText}`,
    readOriginalUserTurns: async () => originalTurns,
    runReminderService: async () => { pairRunnerCalls += 1; },
  }));
}
assert.equal(pairRunnerCalls, 1);
console.log("NATIVE_TWO_CALENDAR_PLAN_ADMISSION_AND_PROVENANCE=PASS");

const productionRequest = "שני תזכורת יום שלישי הבא לשעה 11:00 ושעה 17:00: 'יעלי', כולל ביומן לחצי שעה";
const orensSourceId = recipientsConfig.recipients.find((item) => item.id === "oren").to;
const orensRoute = contracts.resolveReminderRuntimeRoute({
  deliveryContext: { channel: "whatsapp", accountId: recipientsConfig.accountId, to: orensSourceId },
  requesterSenderId: orensSourceId,
});
const productionNow = Date.now();
const productionItem = (hour) => {
  const resolvedTime = `2026-09-29T${hour}:00:00+03:00`;
  const scheduleQuote = "יום שלישי הבא לשעה 11:00 ושעה 17:00";
  return {
    requesterId: "oren",
    sourceConversation: { type: "private", id: orensSourceId },
    recipientIds: ["oren"],
    content: "יעלי",
    verbatimRequest: productionRequest,
    provenance: {
      schemaVersion: 1,
      requesterId: "oren",
      contextId: `yaeli-two-events-2026-09-29-${hour}`,
      revision: 1,
      createdAt: new Date(productionNow - 1000).toISOString(),
      expiresAt: new Date(productionNow + 3600000).toISOString(),
      sourceConversation: { type: "private", id: orensSourceId },
      currentEvidenceId: "ev1",
      evidence: [{ id: "ev1", text: productionRequest }],
      fieldEvidence: [
        { field: "content", evidenceId: "ev1", quote: "'יעלי'" },
        { field: "schedule", evidenceId: "ev1", quote: scheduleQuote },
        { field: "calendar.requested", evidenceId: "ev1", quote: "כולל ביומן" },
        { field: "calendar.durationMinutes", evidenceId: "ev1", quote: "לחצי שעה" },
        { field: "calendar.eventSchedule", evidenceId: "ev1", quote: scheduleQuote },
      ],
    },
    schedule: { type: "one-shot", resolvedTime, timezone: "Asia/Jerusalem" },
    calendar: {
      calendarId: "primary",
      requested: true,
      durationMinutes: 30,
      eventSchedule: { type: "one-shot", resolvedTime, timezone: "Asia/Jerusalem" },
    },
    notifyRecipients: true,
  };
};
const sanitizedProductionPlan = {
  input: { items: [productionItem("11"), productionItem("17")] },
};
const productionPairSchema = contracts.reminderSchemaForRuntimeRoute(pairDefinition, orensRoute);
assert.doesNotThrow(() => validateToolArguments(
  { name: pairDefinition.name, parameters: productionPairSchema },
  { name: pairDefinition.name, arguments: sanitizedProductionPlan },
));

const productionLeafCitation = structuredClone(sanitizedProductionPlan);
productionLeafCitation.input.items[0].provenance.fieldEvidence
  .find((citation) => citation.field === "schedule").field = "schedule.resolvedTime";
assert.equal(validateJsonSchemaValue({
  schema: productionPairSchema,
  value: productionLeafCitation,
  cacheKey: "test:production-plan-reject:leaf-citation",
  applyDefaults: false,
}).ok, false, "plan schema accepted a non-semantic provenance leaf path");

const productionSuperset = structuredClone(sanitizedProductionPlan);
for (const item of productionSuperset.input.items) {
  const extras = { cron: "unused", offset: { value: 1, unit: "seconds" }, reference: "request" };
  Object.assign(item.schedule, extras);
  item.schedules = [{ ...item.schedule }];
  Object.assign(item.calendar.eventSchedule, extras);
  for (const field of ["summary", "description", "location"]) {
    item.calendar[field] = { value: "יעלי", evidenceQuote: "'יעלי'", evidenceId: "ev1" };
  }
}
assert.throws(() => validateToolArguments(
  { name: pairDefinition.name, parameters: productionPairSchema },
  { name: pairDefinition.name, arguments: productionSuperset },
), undefined, "native admission accepted the captured production superset");

for (const [label, mutate] of [
  ["schedules", (item) => { item.schedules = [{ ...item.schedule }]; }],
  ["schedule.cron", (item) => { item.schedule.cron = "unused"; }],
  ["schedule.offset", (item) => { item.schedule.offset = { value: 1, unit: "seconds" }; }],
  ["schedule.reference", (item) => { item.schedule.reference = "request"; }],
  ["eventSchedule.cron", (item) => { item.calendar.eventSchedule.cron = "unused"; }],
  ["eventSchedule.offset", (item) => { item.calendar.eventSchedule.offset = { value: 1, unit: "seconds" }; }],
  ["eventSchedule.reference", (item) => { item.calendar.eventSchedule.reference = "request"; }],
  ["calendar.summary", (item) => { item.calendar.summary = { value: "יעלי", evidenceQuote: "'יעלי'", evidenceId: "ev1" }; }],
  ["calendar.description", (item) => { item.calendar.description = { value: "יעלי", evidenceQuote: "'יעלי'", evidenceId: "ev1" }; }],
  ["calendar.location", (item) => { item.calendar.location = { value: "יעלי", evidenceQuote: "'יעלי'", evidenceId: "ev1" }; }],
]) {
  const invalid = structuredClone(sanitizedProductionPlan);
  mutate(invalid.input.items[0]);
  assert.equal(validateJsonSchemaValue({
    schema: productionPairSchema,
    value: invalid,
    cacheKey: `test:production-plan-reject:${label}`,
    applyDefaults: false,
  }).ok, false, `${label} passed strict plan schema`);
}

let productionPlanRunnerCalls = 0;
await contracts.executeReminderTool(pairDefinition, sanitizedProductionPlan, undefined, {
  validateJsonSchemaValue,
  runtimeRoute: orensRoute,
  runtimeSchema: productionPairSchema,
  readCurrentUserText: async () => productionRequest,
  readOriginalUserTurns: async () => [
    { text: productionRequest },
    { text: "An unrelated later request" },
    { text: productionRequest },
  ],
  runReminderService: async (params) => {
    productionPlanRunnerCalls += 1;
    for (const item of params.input.items) {
      assert.deepEqual(
        Object.keys(item.calendar).sort(),
        ["calendarId", "durationMinutes", "eventSchedule", "requested"],
      );
      assert.deepEqual(Object.keys(item.schedule).sort(), ["resolvedTime", "timezone", "type"]);
      assert.deepEqual(Object.keys(item.calendar.eventSchedule).sort(), ["resolvedTime", "timezone", "type"]);
    }
    return { status: "success" };
  },
});
assert.equal(productionPlanRunnerCalls, 1);
console.log("PROVENANCE_LATEST_DUPLICATE_TURN=PASS");

const secondaryWithoutEvidence = structuredClone(sanitizedProductionPlan);
secondaryWithoutEvidence.input.items[0].recipientIds.push("ilana");
await assert.rejects(() => contracts.executeReminderTool(
  pairDefinition, secondaryWithoutEvidence, undefined, {
    validateJsonSchemaValue,
    runtimeRoute: orensRoute,
    runtimeSchema: productionPairSchema,
    readCurrentUserText: async () => productionRequest,
    readOriginalUserTurns: async () => [{ text: productionRequest }],
    runReminderService: async () => {
      productionPlanRunnerCalls += 1;
      return { status: "unexpected" };
    },
  },
), /missing field evidence: recipientIds/);
assert.equal(productionPlanRunnerCalls, 1);
console.log("PRODUCTION_MULTI_TIME_PLAN_SHAPE_REGRESSION=PASS");

let invalidScheduleRunnerCalls = 0;
for (const invalid of ["both", "neither"]) {
  const params = structuredClone(validParameters.benson_reminder_create);
  if (invalid === "both") params.input.schedules = [params.input.schedule];
  else delete params.input.schedule;
  await assert.rejects(() => contracts.executeReminderTool(createDefinition, params, undefined, {
    validateJsonSchemaValue,
    runReminderService: async () => { invalidScheduleRunnerCalls += 1; return { status: "unexpected" }; },
  }), /exactly one of input.schedule or input.schedules/, invalid);
}
assert.equal(invalidScheduleRunnerCalls, 0);
console.log("NATIVE_CREATE_ADMISSION_AND_EXCLUSIVE_SCHEDULE=PASS");
let planForwarded;
await contracts.executeReminderTool(createDefinition, planParams, undefined, {
  validateJsonSchemaValue, runtimeRoute: ilanasRoute, runtimeSchema: planSchema,
  readCurrentUserText: async () => `Current answer: ${evidenceText}`,
  readOriginalUserTurns: async () => originalTurns,
  runReminderService: async (params) => { planForwarded = params; return { status: "success" }; },
});
assert.equal(planForwarded.input.provenance.contextId, "ctx-contract");
assert.equal(planForwarded.input.schedules.length, 2);
for (const [label, mutate, pattern] of [
  ["expired", (input) => { input.provenance.expiresAt = new Date(now - 1).toISOString(); }, /expired/],
  ["foreign-route", (input) => { input.provenance.requesterId = "oren"; }, /route|allowed values/],
  ["missing-field", (input) => { input.provenance.fieldEvidence = input.provenance.fieldEvidence.filter((item) => item.field !== "schedules[1]"); }, /missing field evidence/],
  ["fabricated-inherited", (input) => { input.provenance.evidence[0].text = "Invented event at a different venue"; }, /not grounded in the current task/],
  ["stale-revision", (input) => { input.provenance.revision = 4; }, /revision/],
  ["wrong-current-turn", (input) => { input.provenance.currentEvidenceId = "turn-3"; }, /current evidence/],
]) {
  const invalid = structuredClone(planParams);
  mutate(invalid.input);
  await assert.rejects(() => contracts.executeReminderTool(createDefinition, invalid, undefined, {
    validateJsonSchemaValue, runtimeRoute: ilanasRoute, runtimeSchema: planSchema,
    readCurrentUserText: async () => evidenceText,
    readOriginalUserTurns: async () => originalTurns,
    runReminderService: async () => ({ status: "unexpected" }),
  }), pattern, label);
}
await assert.rejects(() => contracts.executeReminderTool(createDefinition, planParams, undefined, {
  validateJsonSchemaValue, runtimeRoute: ilanasRoute, runtimeSchema: planSchema,
  readCurrentUserText: async () => "unrelated newer answer",
  readOriginalUserTurns: async () => originalTurns,
  runReminderService: async () => ({ status: "unexpected" }),
}), /not grounded in the current task/);
const forgedBrief = structuredClone(planParams);
forgedBrief.input.provenance.evidence[0].text = "Invented earlier event";
await assert.rejects(() => contracts.executeReminderTool(createDefinition, forgedBrief, undefined, {
  validateJsonSchemaValue, runtimeRoute: ilanasRoute, runtimeSchema: planSchema,
  readCurrentUserText: async () => forgedBrief.input.provenance.evidence.map((turn) => turn.text).join("\n"),
  readOriginalUserTurns: async () => originalTurns,
  runReminderService: async () => ({ status: "unexpected" }),
}), /not in original user turns/);
for (const [label, turns, pattern] of [
  ["stale-current-turn", [...originalTurns, { text: "Unrelated later message" }], /current original user turn/],
  ["missing-original-transcript", [], /original user turns are unavailable/],
  ["out-of-order-evidence", [...originalTurns].reverse(), /not in original user turns/],
]) {
  await assert.rejects(() => contracts.executeReminderTool(createDefinition, planParams, undefined, {
    validateJsonSchemaValue, runtimeRoute: ilanasRoute, runtimeSchema: planSchema,
    readCurrentUserText: async () => evidenceText,
    readOriginalUserTurns: async () => turns,
    runReminderService: async () => ({ status: "unexpected" }),
  }), pattern, label);
}
console.log("MULTI_TURN_PROVENANCE_ADMISSION=PASS");

const updateDefinition = definitions.get("benson_reminder_update");
assert.equal(validateJsonSchemaValue({
  schema: updateDefinition.schema,
  value: { reminderId: "rem-contract", requesterId: "oren",
    input: { recipientId: "amit", schedule: { type: "recurring", cron: "0 8 * * *", timezone: "Asia/Jerusalem" } } },
  cacheKey: "test:update:recipient-specific", applyDefaults: false,
}).ok, true);
const invalidUpdate = {
  reminderId: "rem-contract",
  requesterId: "oren",
  input: { content: "updated" },
  recipient: "unused",
};
let runnerCalls = 0;
await assert.rejects(
  () => contracts.executeReminderTool(
    updateDefinition,
    invalidUpdate,
    undefined,
    {
      validateJsonSchemaValue,
      runReminderService: async () => {
        runnerCalls += 1;
        return { status: "unexpected" };
      },
    },
  ),
  /must not have additional properties: "recipient"/,
);
assert.equal(runnerCalls, 0);

let forwarded;
await contracts.executeReminderTool(
  updateDefinition,
  validParameters.benson_reminder_update,
  undefined,
  {
    validateJsonSchemaValue,
    runReminderService: async (params) => {
      runnerCalls += 1;
      forwarded = params;
      return { status: "success" };
    },
  },
);
assert.equal(runnerCalls, 1);
assert.equal(forwarded.operation, "update-reminder");
assert.equal(Object.hasOwn(validParameters.benson_reminder_update, "operation"), false);
console.log("NARROW_TOOL_NATIVE_SCHEMA_BOUNDARY=PASS");

assert.deepEqual(
  runner.buildArgv({
    operation: "update-reminder",
    reminderId: "rem-contract",
    requesterId: "oren",
    input: { content: "updated" },
  }),
  [
    "update-reminder", "--reminder-id", "rem-contract", "--requester", "oren",
    "--input-json", JSON.stringify({ content: "updated" }),
  ],
);
assert.throws(
  () => runner.buildArgv({
    operation: "update-reminder",
    reminderId: "rem-contract",
    requesterId: "oren",
    input: { recipientIds: ["maya"] },
  }),
  /unsupported Reminder update fields: recipientIds/,
);
assert.deepEqual(
  runner.buildArgv({ operation: "update-reminder", reminderId: "rem-contract",
    requesterId: "oren", input: { recipientId: "maya", content: "changed" } }),
  ["update-reminder", "--reminder-id", "rem-contract", "--requester", "oren",
    "--input-json", JSON.stringify({ recipientId: "maya", content: "changed" })],
);
assert.throws(
  () => runner.buildArgv({
    operation: "update-reminder",
    reminderId: "rem-contract",
    requesterId: "oren",
    input: {},
  }),
  /must not be empty/,
);
console.log("PLUGIN_EXECUTABLE_AND_UPDATE_CONTRACT=PASS");
JS

TMP="$(mktemp -d /tmp/benson-reminder-native-test.XXXXXX)"
trap 'rm -rf -- "$TMP"' EXIT
mkdir -p "$TMP/links"

cat > "$TMP/recipients.json" <<'JSON'
{
  "accountId": "benson",
  "timezone": "Asia/Jerusalem",
  "trustedRequesterIds": ["oren", "maya"],
  "recipients": [
    {"id":"oren","displayName":"Oren","type":"person","channel":"whatsapp","to":"+972500000001","aliases":["dad"]},
    {"id":"maya","displayName":"Maya","type":"person","channel":"whatsapp","to":"+972500000002","aliases":[]},
    {"id":"family","displayName":"Family","type":"group","channel":"whatsapp","to":"test-family@g.us","aliases":[]}
  ]
}
JSON

cat > "$TMP/openclaw" <<'PY'
#!/usr/bin/env python3
import datetime as dt
import json, os, sys, time, uuid
from pathlib import Path
a=sys.argv[1:]
p=Path(os.environ['FAKE_AUTOMATIONS'])
def load(): return json.loads(p.read_text()) if p.exists() else {}
def save(v): p.write_text(json.dumps(v,ensure_ascii=False,sort_keys=True)+'\n')
def opt(name, default=None): return a[a.index(name)+1] if name in a else default
state=load()
if a[:2]==['automations','list']:
    print(json.dumps({'jobs':list(state.values())},ensure_ascii=False)); raise SystemExit(0)
if a[:2]==['automations','get']:
    job=state.get(a[2])
    if not job: print('not found',file=sys.stderr); raise SystemExit(1)
    print(json.dumps(job,ensure_ascii=False)); raise SystemExit(0)
if a[:2]==['automations','add']:
    job_id='job-'+uuid.uuid4().hex[:12]
    recurring='--cron' in a
    now=int(time.time()*1000)
    at_value=opt('--at')
    if at_value and os.environ.get('FAKE_CANONICALIZE_AT')=='1':
      at_value=dt.datetime.fromisoformat(at_value.replace('Z','+00:00')).astimezone(dt.timezone.utc).isoformat(timespec='seconds').replace('+00:00','Z')
    job={
      'id':job_id,'name':opt('--name'),'description':opt('--description'),
      'declarationKey':opt('--declaration-key'),'agentId':opt('--agent'),
      'sessionTarget':opt('--session'),'sessionKey':opt('--session-key'),
      'enabled':'--disabled' not in a,'createdAtMs':now,'updatedAtMs':now,
      'schedule':({'kind':'cron','expr':opt('--cron'),'tz':opt('--tz')} if recurring else {'kind':'at','at':at_value}),
      'payload':{'kind':'command','argv':json.loads(opt('--command-argv'))},
      'delivery':{'mode':'announce','channel':opt('--channel'),'to':opt('--to'),'accountId':opt('--account'),'bestEffort':'--best-effort-deliver' in a},
      'deleteAfterRun':'--delete-after-run' in a,
    }
    state[job_id]=job; save(state); print(json.dumps(job,ensure_ascii=False)); raise SystemExit(0)
if a[:2] in (['automations','disable'],['automations','enable']):
    if a[2] not in state: raise SystemExit(1)
    state[a[2]]['enabled']=a[1]=='enable'; state[a[2]]['updatedAtMs']=int(time.time()*1000); save(state); print('ok'); raise SystemExit(0)
if a[:2]==['automations','edit']:
    job=state.get(a[2])
    if not job: raise SystemExit(1)
    if '--command-argv' in a: job['payload']['argv']=json.loads(opt('--command-argv'))
    if '--description' in a: job['description']=opt('--description')
    if '--agent' in a: job['agentId']=opt('--agent')
    if '--session' in a: job['sessionTarget']=opt('--session')
    if '--session-key' in a: job['sessionKey']=opt('--session-key')
    if '--at' in a: job['schedule']={'kind':'at','at':opt('--at')}; job['deleteAfterRun']=True
    if '--cron' in a: job['schedule']={'kind':'cron','expr':opt('--cron'),'tz':opt('--tz')}; job['deleteAfterRun']=False
    job['updatedAtMs']=int(time.time()*1000); save(state); print('ok'); raise SystemExit(0)
if a[:2]==['automations','rm']:
    if a[2] not in state: raise SystemExit(1)
    fail_after=a[2]==os.environ.get('FAKE_RM_FAIL_AFTER_JOB_ID')
    del state[a[2]]; save(state)
    if fail_after: print('injected failure after remove',file=sys.stderr); raise SystemExit(1)
    print('ok'); raise SystemExit(0)
print('unsupported '+repr(a),file=sys.stderr); raise SystemExit(2)
PY
chmod 700 "$TMP/openclaw"
printf '%s\n' '{}' > "$TMP/automations.json"

run_tool() {
  OPENCLAW_BIN="$TMP/openclaw" \
  FAKE_AUTOMATIONS="$TMP/automations.json" \
  REMINDER_LINK_DIR="$TMP/links" \
  REMINDER_RECIPIENTS_CONFIG="$TMP/recipients.json" \
  "$TOOL" "$@"
}

set +e
BLANK_DISCOVERY="$(run_tool find-reminders --requester oren --job-id '   ')"
BLANK_DISCOVERY_RC=$?
set -e
[[ "$BLANK_DISCOVERY_RC" -ne 0 ]]
python3 - "$BLANK_DISCOVERY" <<'PY'
import json,sys
r=json.loads(sys.argv[1]); assert r['error']['code']=='REMINDER_DISCOVERY_FILTER_INVALID',r
print('DIRECT_DISCOVERY_WHITESPACE_REJECTED=PASS')
PY
NORMAL_DISCOVERY="$(run_tool find-reminders --requester oren)"
python3 - "$NORMAL_DISCOVERY" <<'PY'
import json,sys
r=json.loads(sys.argv[1]); assert r['status']=='success' and r['matchCount']==0,r
print('OMITTED_DISCOVERY_FILTERS_WORK=PASS')
PY

FUTURE="2099-02-03T11:22:17+02:00"
INTENT="$(python3 - "$FUTURE" <<'PY'
import json,sys
print(json.dumps({
  'sourceConversation':{'type':'private','id':'+972500000001'},
  'requesterId':'oren','recipientIds':['oren'],'content':'native source test',
  'schedule':{'type':'one-shot','resolvedTime':sys.argv[1],'timezone':'Asia/Jerusalem'},
  'calendar':{'requested':False}},ensure_ascii=False,separators=(',',':')))
PY
)"

CREATE="$(run_tool create-intent --input-json "$INTENT")"
RID="$(python3 -c 'import json,sys; v=json.load(sys.stdin); assert v["status"]=="success" and v["transaction"]["verified"] is True; print(v["reminderId"])' <<<"$CREATE")"
python3 -c 'import json,sys; v=json.load(sys.stdin); assert v["transport"]["deliveries"]==[]; print("SELF_RECIPIENT_NOTIFICATION_SUPPRESSED=PASS")' <<<"$CREATE"
[[ -z "$(find "$TMP/links" -maxdepth 1 -type f -print -quit)" ]] || fail 'non-Calendar Reminder wrote parallel state'
python3 - "$TMP/automations.json" <<'PY'
import json,sys
jobs=json.load(open(sys.argv[1])); assert len(jobs)==1,jobs
j=next(iter(jobs.values()))
assert j['agentId']=='reminder-service' and j['sessionTarget']=='isolated',j
assert j['payload']['kind']=='command' and j['delivery']['mode']=='announce',j
assert j['description'].startswith('benson.reminder-service.v4:'),j
meta=json.loads(j['description'].split(':',1)[1]); assert meta['createdBy']=='oren',meta
assert j['declarationKey'].startswith('benson-reminder:'),j
print('CREATE_USES_NATIVE_AUTOMATION=PASS')
print('CREATOR_OWNERSHIP_METADATA=PASS')
print('SECOND_COMPLETE_REGISTRY=false')
PY

# Simulate a pre-ownership v4 Reminder. Missing creator metadata must never be
# guessed, while the recipient retains self-service access.
python3 - "$TMP/automations.json" <<'PY'
import json,sys
p=sys.argv[1]
jobs=json.load(open(p))
job=next(iter(jobs.values()))
prefix='benson.reminder-service.v4:'
meta=json.loads(job['description'][len(prefix):])
meta.pop('createdBy',None)
job['description']=prefix+json.dumps(meta,ensure_ascii=False,separators=(',',':'))
json.dump(jobs,open(p,'w'),ensure_ascii=False,sort_keys=True)
PY

RETRY="$(run_tool create-intent --input-json "$INTENT")"
python3 -c 'import json,sys; v=json.load(sys.stdin); assert v["status"]=="success" and v["idempotent"] is True' <<<"$RETRY"

LIST="$(run_tool list-reminders --requester oren)"
python3 - "$LIST" "$RID" <<'PY'
import json,sys
v=json.loads(sys.argv[1]); assert v['verified'] is True and v['matchCount']==1,v
assert v['matches'][0]['reminderId']==sys.argv[2],v
print('DISCOVERY_FROM_NATIVE_AUTOMATIONS=PASS')
PY

for identity in oren +972500000001 dad; do
  FILTERED="$(run_tool list-reminders --requester oren --recipient "$identity")"
  python3 - "$FILTERED" "$RID" "$identity" <<'PY'
import json,sys
v=json.loads(sys.argv[1])
assert v['verified'] is True and v['matchCount']==1,(sys.argv[3],v)
assert v['matches'][0]['reminderId']==sys.argv[2],(sys.argv[3],v)
PY
done
echo 'DISCOVERY_RECIPIENT_IDENTITY_NORMALIZATION=PASS'

set +e
UNKNOWN_RECIPIENT="$(run_tool list-reminders --requester oren --recipient unknown-person)"
UNKNOWN_RECIPIENT_RC=$?
set -e
[[ "$UNKNOWN_RECIPIENT_RC" -ne 0 ]]
python3 -c 'import json,sys; v=json.load(sys.stdin); assert v["error"]["code"]=="REMINDER_IDENTITY_UNKNOWN"; print("DISCOVERY_UNKNOWN_IDENTITY_FAILS_CLOSED=PASS")' <<<"$UNKNOWN_RECIPIENT"

# Prove that discovery reads native payload state rather than a copied record.
python3 - "$TMP/automations.json" <<'PY'
import json,sys
p=sys.argv[1]; v=json.load(open(p)); j=next(iter(v.values())); j['payload']['argv'][-1]='תזכורת: changed in native store'; json.dump(v,open(p,'w'),ensure_ascii=False)
PY
run_tool find-reminders --requester oren --text 'changed in native store' | python3 -c 'import json,sys; v=json.load(sys.stdin); assert v["matchCount"]==1; print("NATIVE_STORE_IS_SOURCE_OF_TRUTH=PASS")'

run_tool pause-reminder --reminder-id "$RID" --requester oren | python3 -c 'import json,sys; v=json.load(sys.stdin); assert v["transaction"]["verified"] is True'
run_tool resume-reminder --reminder-id "$RID" --requester oren | python3 -c 'import json,sys; v=json.load(sys.stdin); assert v["transaction"]["verified"] is True'
run_tool update-reminder --reminder-id "$RID" --requester oren --input-json '{"content":"updated native content"}' | python3 -c 'import json,sys; v=json.load(sys.stdin); assert v["status"]=="success" and v["data"]["record"]["content"]=="updated native content"'

set +e
BAD="$(run_tool update-reminder --reminder-id "$RID" --requester oren --input-json '{"schedule":{"type":"relative","baseTime":"2099-01-01T00:00:00Z","offset":{"value":1,"unit":"hours"},"timezone":"UTC"}}')"
BAD_RC=$?
set -e
[[ "$BAD_RC" -ne 0 ]]
python3 -c 'import json,sys; v=json.load(sys.stdin); assert v["error"]["code"]=="REMINDER_SCHEDULE_UNTRUSTED_BASE"; print("UNTRUSTED_RELATIVE_BASE_REJECTED=PASS")' <<<"$BAD"

run_tool delete-reminder --reminder-id "$RID" --requester oren | python3 -c 'import json,sys; v=json.load(sys.stdin); assert v["status"]=="success" and v["transaction"]["verified"] is True'
python3 - "$TMP/automations.json" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))=={}
print('NATIVE_LIFECYCLE=PASS')
PY

# Exact secondary-recipient lifecycle contract. The existing create delivery
# intent is reused for every verified lifecycle transition; scheduled native
# Automation delivery remains separate.
OTHER_INTENT="$(python3 - "$FUTURE" <<'PY'
import json,sys
print(json.dumps({
  'sourceConversation':{'type':'private','id':'+972500000001'},
  'requesterId':'oren','recipientIds':['maya'],'content':'secondary lifecycle test',
  'schedule':{'type':'one-shot','resolvedTime':sys.argv[1],'timezone':'Asia/Jerusalem'},
  'calendar':{'requested':False},'notifyRecipients':True},
  ensure_ascii=False,separators=(',',':')))
PY
)"

OTHER_CREATE="$(run_tool create-intent --input-json "$OTHER_INTENT")"
OTHER_RID="$(python3 - "$OTHER_CREATE" "$TMP/automations.json" <<'PY'
import json,sys
result=json.loads(sys.argv[1]); jobs=json.load(open(sys.argv[2]))
assert result['status']=='success' and result['transaction']['verified'] is True,result
deliveries=result['transport']['deliveries']; assert len(deliveries)==1,deliveries
delivery=deliveries[0]
assert delivery['operation']=='create' and delivery['status']=='pending',delivery
assert delivery['target']['recipientId']=='maya' and delivery['target']['to']=='+972500000002',delivery
assert delivery['idempotencyKey'].startswith('benson-reminder-lifecycle:'),delivery
assert delivery['onFailure']['stateChangePreserved'] is True,delivery
assert len(jobs)==1,jobs
job=next(iter(jobs.values()))
assert job['delivery']['to']=='+972500000002',job
assert job['schedule']=={'kind':'at','at':'2099-02-03T11:22:17+02:00'},job
print(result['reminderId'])
PY
)"
echo 'SECONDARY_CREATE_IMMEDIATE_AND_SCHEDULED=PASS'

OTHER_RETRY="$(run_tool create-intent --input-json "$OTHER_INTENT")"
python3 - "$OTHER_CREATE" "$OTHER_RETRY" <<'PY'
import json,sys
first,retry=map(json.loads,sys.argv[1:])
assert retry.get('idempotent') is True,retry
a=first['transport']['deliveries'][0]
b=retry['transport']['deliveries'][0]
assert a['idempotencyKey']==b['idempotencyKey'],(a,b)
sent={}
for delivery in (a,b):
    sent.setdefault(delivery['idempotencyKey'],delivery)
assert len(sent)==1,sent
print('LIFECYCLE_NOTIFICATION_RETRY_DEDUPES=PASS')
PY

run_tool find-reminders --requester maya --reminder-id "$OTHER_RID" | python3 -c 'import json,sys; v=json.load(sys.stdin); assert v["matchCount"]==1,v; print("RECIPIENT_SELF_SERVICE_DISCOVERY=PASS")'
MAYA_UPDATE="$(run_tool update-reminder --reminder-id "$OTHER_RID" --requester maya --input-json '{"content":"recipient self-service update"}')"
python3 -c 'import json,sys; v=json.load(sys.stdin); assert v["status"]=="success" and v["data"]["record"]["createdBy"]=="oren",v; print("RECIPIENT_SELF_SERVICE_LIFECYCLE=PASS")' <<<"$MAYA_UPDATE"

NEW_TIME='2099-02-04T14:35:00+02:00'
OTHER_UPDATE="$(run_tool update-reminder --reminder-id "$OTHER_RID" --requester oren --input-json "{\"schedule\":{\"type\":\"one-shot\",\"resolvedTime\":\"$NEW_TIME\",\"timezone\":\"Asia/Jerusalem\"}}")"
python3 - "$OTHER_UPDATE" "$TMP/automations.json" "$FUTURE" "$NEW_TIME" <<'PY'
import json,sys
result=json.loads(sys.argv[1]); jobs=json.load(open(sys.argv[2])); old,new=sys.argv[3:]
assert result['status']=='success' and result['transaction']['verified'] is True,result
delivery=result['transport']['deliveries'][0]
assert delivery['operation']=='update' and '14:35' in delivery['text'],delivery
job=next(iter(jobs.values()))
assert job['schedule']=={'kind':'at','at':new},job
assert old not in json.dumps(job,ensure_ascii=False),job
assert result['transport']['deliveryFailurePolicy']['stateChangePreserved'] is True,result
# Simulate a native message failure: the already verified Automation state is
# unchanged and the structured warning remains available to Main.
assert delivery['onFailure']['code']=='REMINDER_RECIPIENT_NOTIFICATION_FAILED',delivery
assert next(iter(json.load(open(sys.argv[2])).values()))['schedule']['at']==new
print('UPDATE_NOTIFICATION_AFTER_VERIFIED_NEW_TIME=PASS')
print('DELIVERY_FAILURE_PRESERVES_REMINDER_STATE=PASS')
PY

for operation in pause resume; do
  RESULT="$(run_tool "${operation}-reminder" --reminder-id "$OTHER_RID" --requester oren)"
  python3 - "$RESULT" "$operation" <<'PY'
import json,sys
result=json.loads(sys.argv[1]); operation=sys.argv[2]
assert result['status']=='success' and result['transaction']['verified'] is True,result
deliveries=result['transport']['deliveries']; assert len(deliveries)==1,deliveries
assert deliveries[0]['operation']==operation,deliveries
print(operation.upper()+'_SECONDARY_NOTIFICATION=PASS')
PY
done

OTHER_DELETE="$(run_tool delete-reminder --reminder-id "$OTHER_RID" --requester oren)"
python3 - "$OTHER_DELETE" "$TMP/automations.json" <<'PY'
import json,sys
result=json.loads(sys.argv[1]); jobs=json.load(open(sys.argv[2]))
assert result['status']=='success' and result['transaction']['verified'] is True,result
deliveries=result['transport']['deliveries']; assert len(deliveries)==1,deliveries
assert deliveries[0]['operation']=='delete',deliveries
assert jobs=={},jobs
print('DELETE_SECONDARY_NOTIFICATION=PASS')
PY

# A requester may not discover or mutate an unrelated Reminder created by
# another requester for a different recipient.
MAYA_PRIVATE_INTENT="$(python3 - "$FUTURE" <<'PY'
import json,sys
print(json.dumps({
  'sourceConversation':{'type':'private','id':'+972500000002'},
  'requesterId':'maya','recipientIds':['maya'],'content':'maya private ownership',
  'schedule':{'type':'one-shot','resolvedTime':sys.argv[1],'timezone':'Asia/Jerusalem'},
  'calendar':{'requested':False},'notifyRecipients':False},
  ensure_ascii=False,separators=(',',':')))
PY
)"
MAYA_PRIVATE_CREATE="$(run_tool create-intent --input-json "$MAYA_PRIVATE_INTENT")"
MAYA_PRIVATE_RID="$(python3 -c 'import json,sys; v=json.load(sys.stdin); assert v["data"]["record"]["createdBy"]=="maya",v; print(v["reminderId"])' <<<"$MAYA_PRIVATE_CREATE")"
run_tool find-reminders --requester oren --text 'maya private ownership' | python3 -c 'import json,sys; v=json.load(sys.stdin); assert v["matchCount"]==0,v; print("UNRELATED_DISCOVERY_FILTERED=PASS")'
BEFORE_DENIED_HASH="$(sha256sum "$TMP/automations.json" | awk '{print $1}')"
set +e
DENIED="$(run_tool update-reminder --reminder-id "$MAYA_PRIVATE_RID" --requester oren --input-json '{"content":"must not change"}')"
DENIED_RC=$?
set -e
[[ "$DENIED_RC" -ne 0 ]]
AFTER_DENIED_HASH="$(sha256sum "$TMP/automations.json" | awk '{print $1}')"
[[ "$BEFORE_DENIED_HASH" == "$AFTER_DENIED_HASH" ]]
python3 -c 'import json,sys; v=json.load(sys.stdin); assert v["error"]["code"]=="REMINDER_AUTHORIZATION_DENIED",v; print("UNRELATED_LIFECYCLE_DENIED_BEFORE_SIDE_EFFECT=PASS")' <<<"$DENIED"
run_tool delete-reminder --reminder-id "$MAYA_PRIVATE_RID" --requester maya >/dev/null

# Trusted requesters may create and manage shared-target Reminders. A group id
# itself is not a trusted requester.
GROUP_INTENT="$(python3 - "$FUTURE" <<'PY'
import json,sys
print(json.dumps({
  'sourceConversation':{'type':'private','id':'+972500000001'},
  'requesterId':'oren','recipientIds':['family'],'content':'shared target ownership',
  'schedule':{'type':'one-shot','resolvedTime':sys.argv[1],'timezone':'Asia/Jerusalem'},
  'calendar':{'requested':False},'notifyRecipients':False},
  ensure_ascii=False,separators=(',',':')))
PY
)"
GROUP_CREATE="$(run_tool create-intent --input-json "$GROUP_INTENT")"
GROUP_RID="$(python3 -c 'import json,sys; v=json.load(sys.stdin); assert v["data"]["record"]["createdBy"]=="oren",v; print(v["reminderId"])' <<<"$GROUP_CREATE")"
run_tool delete-reminder --reminder-id "$GROUP_RID" --requester oren >/dev/null

UNTRUSTED_INTENT="$(python3 - "$FUTURE" <<'PY'
import json,sys
print(json.dumps({
  'sourceConversation':{'type':'group','id':'test-family@g.us'},
  'requesterId':'family','recipientIds':['family'],'content':'untrusted requester',
  'schedule':{'type':'one-shot','resolvedTime':sys.argv[1],'timezone':'Asia/Jerusalem'},
  'calendar':{'requested':False}},ensure_ascii=False,separators=(',',':')))
PY
)"
set +e
UNTRUSTED="$(run_tool create-intent --input-json "$UNTRUSTED_INTENT")"
UNTRUSTED_RC=$?
set -e
[[ "$UNTRUSTED_RC" -ne 0 ]]
python3 -c 'import json,sys; v=json.load(sys.stdin); assert v["error"]["code"]=="REMINDER_REQUESTER_UNTRUSTED",v; print("UNTRUSTED_REQUESTER_FAILS_CLOSED=PASS")' <<<"$UNTRUSTED"

UNKNOWN_REQUESTER_INTENT="$(python3 - "$UNTRUSTED_INTENT" <<'PY'
import json,sys
value=json.loads(sys.argv[1]); value['requesterId']='unknown-person'
print(json.dumps(value,ensure_ascii=False,separators=(',',':')))
PY
)"
set +e
UNKNOWN_REQUESTER="$(run_tool create-intent --input-json "$UNKNOWN_REQUESTER_INTENT")"
UNKNOWN_REQUESTER_RC=$?
set -e
[[ "$UNKNOWN_REQUESTER_RC" -ne 0 ]]
python3 -c 'import json,sys; v=json.load(sys.stdin); assert v["error"]["code"]=="REMINDER_REQUESTER_UNTRUSTED",v; print("UNKNOWN_REQUESTER_FAILS_CLOSED=PASS")' <<<"$UNKNOWN_REQUESTER"
python3 - "$TMP/automations.json" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))=={}
print('AUTHORIZATION_FAILURES_HAVE_NO_SIDE_EFFECTS=PASS')
PY

# One logical v4 Reminder may own several native Automation jobs. Exercise a
# person plus a shared group target, a combined content/recurrence update, and
# lifecycle operations over the complete managed group.
MULTI_INTENT="$(python3 - "$FUTURE" <<'PY'
import json,sys
print(json.dumps({
  'sourceConversation':{'type':'private','id':'+972500000001'},
  'requesterId':'oren','recipientIds':['maya','family'],
  'content':'multi recipient recurrence contract',
  'schedule':{'type':'one-shot','resolvedTime':sys.argv[1],'timezone':'Asia/Jerusalem'},
  'calendar':{'requested':False},'notifyRecipients':True},
  ensure_ascii=False,separators=(',',':')))
PY
)"
MULTI_CREATE="$(run_tool create-intent --input-json "$MULTI_INTENT")"
MULTI_RID="$(python3 - "$MULTI_CREATE" "$TMP/automations.json" <<'PY'
import json,sys
result=json.loads(sys.argv[1]); jobs=json.load(open(sys.argv[2]))
assert result['status']=='success' and result['transaction']['verified'] is True,result
record=result['data']['record']
assert record['schemaVersion']==4 and record['createdBy']=='oren',record
assert record['recipientIds']==['maya','family'],record
assert len(record['cronJobs'])==2 and len(jobs)==2,(record,jobs)
assert {item['recipientId'] for item in record['cronJobs']}=={'maya','family'},record
metadata=[json.loads(job['description'].split(':',1)[1]) for job in jobs.values()]
assert {item['recipientId'] for item in metadata}=={'maya','family'},metadata
assert {item['index'] for item in metadata}=={1,2},metadata
assert all(item['reminderId']==record['reminderId'] for item in metadata),metadata
assert {item['target']['recipientId'] for item in result['transport']['deliveries']}=={'maya','family'},result
print(record['reminderId'])
PY
)"
echo 'MULTI_RECIPIENT_V4_RECONCILIATION=PASS'

MULTI_UPDATE="$(run_tool update-reminder --reminder-id "$MULTI_RID" --requester oren --input-json '{"content":"multi recipient recurrence updated","schedule":{"type":"recurring","cron":"15 8 * * 1","timezone":"Asia/Jerusalem"}}')"
python3 - "$MULTI_UPDATE" "$TMP/automations.json" "$MULTI_RID" <<'PY'
import json,sys
result=json.loads(sys.argv[1]); jobs=json.load(open(sys.argv[2])); reminder_id=sys.argv[3]
assert result['status']=='success' and result['transaction']['verified'] is True,result
record=result['data']['record']
assert record['content']=='multi recipient recurrence updated',record
assert record['schedule']=={'type':'recurring','cron':'15 8 * * 1','timezone':'Asia/Jerusalem'},record
assert len(jobs)==2,jobs
for job in jobs.values():
    assert job['schedule']=={'kind':'cron','expr':'15 8 * * 1','tz':'Asia/Jerusalem'},job
    meta=json.loads(job['description'].split(':',1)[1])
    assert meta['reminderId']==reminder_id and meta['createdBy']=='oren',meta
    assert job['payload']['argv'][-1]=='תזכורת: multi recipient recurrence updated',job
print('MULTI_FIELD_RECURRENCE_UPDATE=PASS')
PY

BEFORE_UNKNOWN_HASH="$(sha256sum "$TMP/automations.json" | awk '{print $1}')"
set +e
UNKNOWN_UPDATE="$(run_tool update-reminder --reminder-id "$MULTI_RID" --requester oren --input-json '{"recipientIds":["oren"]}')"
UNKNOWN_UPDATE_RC=$?
set -e
[[ "$UNKNOWN_UPDATE_RC" -ne 0 ]]
AFTER_UNKNOWN_HASH="$(sha256sum "$TMP/automations.json" | awk '{print $1}')"
[[ "$BEFORE_UNKNOWN_HASH" == "$AFTER_UNKNOWN_HASH" ]]
python3 -c 'import json,sys; v=json.load(sys.stdin); assert v["error"]["code"]=="REMINDER_UPDATE_INVALID",v; print("UNKNOWN_UPDATE_FIELD_REJECTED_BEFORE_SIDE_EFFECT=PASS")' <<<"$UNKNOWN_UPDATE"

for operation in pause resume; do
  MULTI_LIFECYCLE="$(run_tool "${operation}-reminder" --reminder-id "$MULTI_RID" --requester oren)"
  python3 - "$MULTI_LIFECYCLE" "$TMP/automations.json" "$operation" <<'PY'
import json,sys
result=json.loads(sys.argv[1]); jobs=json.load(open(sys.argv[2])); operation=sys.argv[3]
assert result['status']=='success' and result['transaction']['verified'] is True,result
assert len(jobs)==2,jobs
assert all(job['enabled'] is (operation=='resume') for job in jobs.values()),jobs
print('MULTI_RECIPIENT_'+operation.upper()+'=PASS')
PY
done
run_tool delete-reminder --reminder-id "$MULTI_RID" --requester oren >/dev/null
python3 - "$TMP/automations.json" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))=={}
print('MULTI_RECIPIENT_DELETE=PASS')
PY

# A recipient-specific update is one deterministic operation. A simulated
# failure after removal exercises compensation, including ambiguous rm output.
SPLIT_CREATE="$(run_tool create-intent --input-json "$MULTI_INTENT")"
SPLIT_RID="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["reminderId"])' "$SPLIT_CREATE")"
OLD_TARGET_JOB="$(python3 -c 'import json,sys; r=json.loads(sys.argv[1])["data"]["record"]; print(next(x["jobId"] for x in r["cronJobs"] if x["recipientId"]=="maya"))' "$SPLIT_CREATE")"
OLD_UNAFFECTED_JOB="$(python3 -c 'import json,sys; r=json.loads(sys.argv[1])["data"]["record"]; print(next(x["jobId"] for x in r["cronJobs"] if x["recipientId"]=="family"))' "$SPLIT_CREATE")"
SPLIT_PATCH='{"recipientId":"maya","schedule":{"type":"recurring","cron":"30 9 * * 2","timezone":"Asia/Jerusalem"}}'
set +e
SPLIT_FAILED="$(FAKE_RM_FAIL_AFTER_JOB_ID="$OLD_TARGET_JOB" run_tool update-reminder --reminder-id "$SPLIT_RID" --requester oren --input-json "$SPLIT_PATCH")"
SPLIT_FAIL_RC=$?
set -e
[[ "$SPLIT_FAIL_RC" -ne 0 ]]
python3 - "$SPLIT_FAILED" "$TMP/automations.json" "$SPLIT_RID" "$OLD_UNAFFECTED_JOB" <<'PY'
import json,sys
result=json.loads(sys.argv[1]); jobs=json.load(open(sys.argv[2]))
assert result['status']=='failure' and result['error']['code']=='REMINDER_UPDATE_PARTIAL_FAILURE',result
assert len(jobs)==2,jobs
assert sys.argv[4] in jobs,jobs
meta=[json.loads(j['description'].split(':',1)[1]) for j in jobs.values()]
assert {m['reminderId'] for m in meta}=={sys.argv[3]},meta
assert {m['recipientId'] for m in meta}=={'maya','family'},meta
print('RECIPIENT_RESTRUCTURE_PARTIAL_FAILURE_COMPENSATED=PASS')
PY
SPLIT_UPDATED="$(run_tool update-reminder --reminder-id "$SPLIT_RID" --requester oren --input-json "$SPLIT_PATCH")"
python3 - "$SPLIT_UPDATED" "$TMP/automations.json" "$SPLIT_RID" "$OLD_UNAFFECTED_JOB" <<'PY'
import json,sys
r=json.loads(sys.argv[1]); jobs=json.load(open(sys.argv[2])); original=sys.argv[3]
assert r['status']=='success' and r['transaction']['verified'] is True,r
unchanged=r['data']['record']; changed=r['data']['restructuredRecord']
assert unchanged['reminderId']==original and unchanged['recipientIds']==['family'],unchanged
assert unchanged['cronJobs'][0]['jobId']==sys.argv[4],unchanged
assert changed['recipientIds']==['maya'] and changed['reminderId']!=original,changed
assert changed['schedule']['cron']=='30 9 * * 2',changed
assert len(jobs)==2,jobs
deliveries=r['transport']['deliveries']
assert {d['target']['recipientId'] for d in deliveries}=={'maya','family'},deliveries
assert all(d['operation']=='update' for d in deliveries),deliveries
assert 'עודכנה' in next(d['text'] for d in deliveries if d['target']['recipientId']=='maya'),deliveries
assert 'לא השתנתה' in next(d['text'] for d in deliveries if d['target']['recipientId']=='family'),deliveries
assert all('נמחקה' not in d['text'] and 'נקבעה' not in d['text'] for d in deliveries),deliveries
print('RECIPIENT_RESTRUCTURE_VERIFIED_SEMANTIC_NOTIFICATIONS=PASS')
PY
SPLIT_NEW_RID="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["data"]["restructuredRecord"]["reminderId"])' "$SPLIT_UPDATED")"
run_tool delete-reminder --reminder-id "$SPLIT_RID" --requester oren >/dev/null
run_tool delete-reminder --reminder-id "$SPLIT_NEW_RID" --requester oren >/dev/null
python3 - "$TMP/automations.json" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))=={}
print('RECIPIENT_RESTRUCTURE_NO_DUPLICATE_OR_ORPHAN=PASS')
PY

# Production stores a relative one-shot update as an equivalent UTC instant,
# not necessarily with the input's Asia/Jerusalem offset representation.
UTC_CREATE="$(run_tool create-intent --input-json "$MULTI_INTENT")"
UTC_RID="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["reminderId"])' "$UTC_CREATE")"
UTC_PATCH='{"recipientId":"maya","schedule":{"type":"relative","timezone":"Asia/Jerusalem","offset":{"value":20,"unit":"minutes"},"reference":"request"}}'
set +e
UTC_UPDATE="$(FAKE_CANONICALIZE_AT=1 run_tool update-reminder --reminder-id "$UTC_RID" --requester oren --input-json "$UTC_PATCH")"
UTC_RC=$?
set -e
python3 - "$UTC_UPDATE" "$UTC_RC" <<'PY'
import json,sys
r=json.loads(sys.argv[1]); rc=int(sys.argv[2])
assert rc==0 and r['status']=='success' and r['transaction']['verified'] is True,r
old=r['data']['record']; changed=r['data']['restructuredRecord']
assert old['recipientIds']==['family'] and changed['recipientIds']==['maya'],r
assert changed['schedule']['resolvedTime'].endswith('+00:00'),changed
print('RECIPIENT_RELATIVE_UTC_READBACK_EQUIVALENCE=PASS')
PY
UTC_NEW_RID="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["data"]["restructuredRecord"]["reminderId"])' "$UTC_UPDATE")"
run_tool delete-reminder --reminder-id "$UTC_RID" --requester oren >/dev/null
run_tool delete-reminder --reminder-id "$UTC_NEW_RID" --requester oren >/dev/null

# Discovery must return every matching logical Reminder and remain read-only.
# The domain agent contract, tested statically above, requires clarification
# instead of choosing an arbitrary match.
for suffix in first second; do
  AMBIGUOUS_INTENT="$(python3 - "$FUTURE" "$suffix" <<'PY'
import json,sys
print(json.dumps({
  'sourceConversation':{'type':'private','id':'+972500000001'},
  'requesterId':'oren','recipientIds':['oren'],
  'content':'ambiguous contract '+sys.argv[2],
  'schedule':{'type':'one-shot','resolvedTime':sys.argv[1],'timezone':'Asia/Jerusalem'},
  'calendar':{'requested':False},'notifyRecipients':False},
  ensure_ascii=False,separators=(',',':')))
PY
)"
  run_tool create-intent --input-json "$AMBIGUOUS_INTENT" > "$TMP/ambiguous-$suffix.json"
done
BEFORE_FIND_HASH="$(sha256sum "$TMP/automations.json" | awk '{print $1}')"
AMBIGUOUS_FIND="$(run_tool find-reminders --requester oren --text 'ambiguous contract')"
AFTER_FIND_HASH="$(sha256sum "$TMP/automations.json" | awk '{print $1}')"
[[ "$BEFORE_FIND_HASH" == "$AFTER_FIND_HASH" ]]
python3 - "$AMBIGUOUS_FIND" <<'PY'
import json,sys
result=json.loads(sys.argv[1])
assert result['verified'] is True and result['matchCount']==2,result
ids={item['reminderId'] for item in result['matches']}
assert len(ids)==2,result
print('MULTI_MATCH_COMPLETE_AND_READ_ONLY=PASS')
PY
for suffix in first second; do
  AMBIGUOUS_RID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["reminderId"])' "$TMP/ambiguous-$suffix.json")"
  run_tool delete-reminder --reminder-id "$AMBIGUOUS_RID" --requester oren >/dev/null
done
python3 - "$TMP/automations.json" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))=={}
print('AMBIGUOUS_FIXTURES_CLEANED=PASS')
PY

PYTHONDONTWRITEBYTECODE=1 "$ROOT/tests/test-reminder-calendar-lifecycle.sh" "$CORE"

echo 'REMINDER_NATIVE_REUSE_CONTRACT=PASS'
