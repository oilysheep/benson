import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import Type, { type Static } from 'typebox';
import Value from 'typebox/value';

// TS01 probes existing owners; no candidate schema is published or made canonical.
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('Expected a record');
  }
  return value;
}
function call(fn: unknown, ...args: unknown[]): unknown {
  if (typeof fn !== 'function') throw new Error('Canonical function missing');
  return fn(...args);
}
async function owner(path: string): Promise<Record<string, unknown>> {
  const value: unknown = await import(pathToFileURL(resolve(path)).href);
  return record(value);
}
const jessica = await owner('agents/jessica-vacuum/lib/schemas.mjs');
const reminder = await owner('integrations/openclaw/plugins/benson-reminder-tool/dist/contracts.js');
const envelope = await owner('integrations/openclaw/benson-routing/envelope.mjs');
const nativeSchemaModule: string = 'openclaw/plugin-sdk/json-schema-runtime';
const native: unknown = await import(nativeSchemaModule);
const nativeCheck = record(native)['validateJsonSchemaValue'];

test('schema-first inferred discriminants compile and reject invalid boundary values', () => {
  const Probe = Type.Union([
    Type.Object({ kind: Type.Literal('accepted'), value: Type.String() }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('rejected'), reason: Type.String() }, { additionalProperties: false }),
  ]);
  type Probe = Static<typeof Probe>;
  function exhaust(value: Probe): string {
    switch (value.kind) {
      case 'accepted': return value.value;
      case 'rejected': return value.reason;
      default: { const unreachable: never = value; return unreachable; }
    }
  }
  const boundary: unknown = { kind: 'accepted', value: 'fixture' };
  assert.ok(Value.Check(Probe, boundary));
  assert.equal(exhaust(boundary), 'fixture');
  for (const invalid of [{ kind: 'future' }, { kind: 'accepted' },
    { kind: 'accepted', value: 'fixture', extra: true }, { kind: 'rejected', reason: null }]) {
    assert.equal(Value.Check(Probe, invalid), false);
  }
});

test('Jessica TypeBox interpretation plus canonical refinements preserves request and UTF-16 semantics', () => {
  const read = record(jessica['READ_REQUEST_SCHEMA']);
  const execute = record(jessica['EXECUTE_REQUEST_SCHEMA']);
  const cases: Array<readonly [Record<string, unknown>, unknown, boolean]> = [
    [read, { operation: 'status' }, true],
    [read, { operation: 'room_settings', room: 'fixture-room' }, true],
    [read, { operation: 'status', extra: 1 }, false],
    [read, { operation: 'operation_status', operationId: '' }, false],
    [read, { operation: 'unknown' }, false],
    [execute, { operation: 'clean', target: { kind: 'rooms', rooms: ['fixture-room'] }, settings: { wetness: 32 } }, true],
    [execute, { operation: 'clean', target: { kind: 'rooms', rooms: ['fixture-room', 'fixture-room'] } }, false],
    [execute, { operation: 'clean', target: { kind: 'rooms', rooms: [] } }, false],
  ];
  for (const wetness of [0, 33, 1.5, NaN, Infinity, '1']) {
    cases.push([execute, { operation: 'clean', target: { kind: 'home' }, settings: { wetness } }, false]);
  }
  // Keep the existing owner authoritative: TypeBox counts code points, legacy bounds use UTF-16.
  for (const room of ['a'.repeat(80), 'a'.repeat(81), '😀'.repeat(40), '😀'.repeat(41),
    '😀'.repeat(80), '😀'.repeat(81), '\ud800'.repeat(80), '\ud800'.repeat(81)]) {
    cases.push([read, { operation: 'room_settings', room }, room.length <= 80]);
    cases.push([execute, { operation: 'clean', target: { kind: 'rooms', rooms: [room] } }, room.length <= 80]);
  }
  let structuralDifferences = 0;
  for (const [schema, input, expected] of cases) {
    const errors = call(jessica['schemaErrors'], schema, input);
    assert.ok(Array.isArray(errors));
    const canonical = errors.length === 0;
    const structural = Value.Check(schema, input);
    structuralDifferences += Number(structural !== canonical);
    assert.equal(canonical, expected);
    assert.equal(structural && canonical, expected);
  }
  assert.equal(structuralDifferences, 4, 'two Unicode boundaries across two request families');
  assert.equal(Object.hasOwn(read, '~kind'), false, 'the canonical JSON schema was not rewritten');
});

test('all Reminder request schemas and DomainResult schema remain interpretable without mutation', () => {
  const definitions = reminder['REMINDER_TOOL_DEFINITIONS'];
  assert.ok(Array.isArray(definitions));
  assert.equal(definitions.length, 8);
  const requesters = reminder['TRUSTED_REQUESTER_IDS'];
  assert.ok(Array.isArray(requesters));
  const requesterId: unknown = requesters[0];
  assert.equal(typeof requesterId, 'string');
  const sourceConversation = { type: 'private', id: 'fixture-conversation' };
  const schedule = { type: 'one-shot', resolvedTime: '2026-10-18T10:00:00+03:00', timezone: 'Asia/Jerusalem' };
  const input = { sourceConversation, requesterId, recipientIds: [requesterId], content: 'fixture', schedule,
    provenance: { schemaVersion: 1, contextId: 'fixture-context', revision: 1,
      createdAt: '2026-10-17T00:00:00Z', expiresAt: '2026-10-18T00:00:00Z',
      sourceConversation, requesterId, currentEvidenceId: 'fixture-evidence',
      evidence: [{ id: 'fixture-evidence', text: 'fixture' }],
      fieldEvidence: [{ field: 'content', evidenceId: 'fixture-evidence', quote: 'fixture' }] },
    calendar: { requested: true, durationMinutes: 30, eventSchedule: schedule } };
  // Structural samples only; service provenance/authorization refinements remain authoritative.
  const samples: Record<string, unknown> = {
    benson_reminder_create: { input },
    benson_reminder_create_plan: { input: { items: [input, structuredClone(input)] } },
    benson_reminder_list: { requesterId },
    benson_reminder_find: { requesterId, text: 'fixture' },
    benson_reminder_update: { requesterId, reminderId: 'fixture-id', input: { content: 'fixture' } },
    benson_reminder_pause: { requesterId, reminderId: 'fixture-id' },
    benson_reminder_resume: { requesterId, reminderId: 'fixture-id' },
    benson_reminder_delete: { requesterId, reminderId: 'fixture-id' },
  };
  for (const raw of definitions) {
    const definition = record(raw);
    const schema = record(definition['schema']);
    const before = JSON.stringify(schema);
    const name = definition['name'];
    assert.equal(typeof name, 'string');
    if (typeof name !== 'string') throw new Error('Missing canonical tool name');
    const sample = samples[name];
    assert.notEqual(sample, undefined);
    for (const value of [sample, null, {}, { unknown: true }, { operation: 'future-version' }]) {
      const result = record(call(nativeCheck, { schema, value }));
      assert.equal(result['ok'], value === sample, name);
      assert.equal(Value.Check(schema, value), result['ok'], name);
    }
    assert.equal(JSON.stringify(schema), before);
  }
  const domain = record(envelope['DOMAIN_RESULT_OUTPUT_SCHEMA']);
  const projected = { schemaVersion: 2, kind: 'benson.domain-result', executionMode: 'deterministic',
    domain: 'reminder', domainSchemaVersion: 'legacy-unversioned', operation: 'list',
    outcome: { disposition: 'handled', status: 'success' },
    facts: { verified: true, verificationScope: ['full_list_read'], data: { matchCount: 0, matches: [] } },
    evidence: { observations: [{ ref: 'fixture-read', observedAt: '2026-10-17T00:00:00Z', freshness: 'fresh' }], gaps: [] },
    warnings: [], failures: { domain: null, handling: null },
    effects: { status: 'none', refs: [], details: [], reconciliation: { required: false, reason: null } },
    uncertainty: [], pendingContext: null, content: { state: 'usable', text: 'No reminders.', language: 'en' } };
  // The canonical validator intentionally returns frozen, null-prototype records.
  assert.equal(JSON.stringify(call(envelope['validateDomainResult'], projected)), JSON.stringify(projected));
  assert.equal(record(call(nativeCheck, { schema: domain, value: projected }))['ok'], true);
  assert.equal(Value.Check(domain, projected), true);
  for (const value of [null, {}, { schemaVersion: 999 }, { kind: 'benson.domain-result' }]) {
    assert.equal(Value.Check(domain, value), false);
  }
});
