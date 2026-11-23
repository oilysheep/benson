import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { OpenClawPluginService } from 'openclaw/plugin-sdk/plugin-entry';
import { createHaEventService, type HaEventConnection, MAX_HA_EVENT_BYTES } from '../adapters/openclaw/ha-event-service.js';
import { createJessicaWarningEventEntry } from '../../../../agents/jessica-vacuum/lib/task.js';
import { loadRegistry } from '../../../../agents/jessica-vacuum/lib/registry.js';
import { prepareJessicaWarningEvent, WARNING_EVENT_MAX_AGE_MS, VACUUM_ENTITY } from '../../../../agents/jessica-vacuum/lib/ha-read.js';
import { validateDomainResultEnvelope, createNoRunDomainResult } from '../core/domain-result.js';
import { createSourceAdmissionController } from '../core/request-control.js';
import { controlReadResponse } from '../core/response-control.js';
import type { DomainResult, NoRunOutcome, SourceInput } from '../core/contracts.js';
import { boundedCopy } from '../core/value.js';

// All source custody and grants below are synthetic retained capabilities.
// No credential, network, native service registry, model or effect API is used.
const epoch = Date.parse('2026-11-16T10:00:00Z');
const sourceRef = 'fixture-ha-connection';
const registry = loadRegistry(JSON.parse(readFileSync('agents/jessica-vacuum/config/registry.v1.json', 'utf8')));
function frame(active: unknown = true, entity = VACUUM_ENTITY, updated = epoch - 1000) {
  return { id: 18, type: 'event', event: { event_type: 'state_changed', time_fired: new Date(epoch).toISOString(),
    origin: 'LOCAL', context: { id: 'synthetic-ha-event', parent_id: null, user_id: null },
    data: { entity_id: entity,
      old_state: { entity_id: entity, state: 'cleaning', attributes: { has_error: false } },
      new_state: { entity_id: entity, state: 'cleaning', attributes: { has_error: active }, last_updated: new Date(updated).toISOString() } } } };
}
function fixture(prepareRequest = prepareJessicaWarningEvent,
  execute?: (input: SourceInput, current: () => void, run: () => DomainResult) => DomainResult | Promise<DomainResult>) {
  const state = { now: epoch, trusted: true, granted: true, sourceRef, subscriptionId: 18, connects: 0, closes: 0,
    unsubscribes: 0, grants: 0, failures: 0, domainFailures: [] as string[], results: [] as DomainResult[],
    receive: (_: string) => {}, gap: () => {}, signal: undefined as AbortSignal | undefined };
  const entry = createJessicaWarningEventEntry({ registry, now: () => state.now,
    readAuthority(input) {
      state.grants++;
      return { inputId: input.source.inputId, sourceType: 'ha', sourceRef,
        domain: 'jessica-vacuum', subject: 'fixture-ha-observer', authorityRef: 'fixture-read-grant', authorityRevision: '1',
        scopes: ['read'], expiresAt: epoch + 60_000, status: state.granted ? 'active' : 'revoked',
        cancelled: false, replayState: 'fresh', commitment: 'uncommitted' };
    } });
  const connection: HaEventConnection = {
    get sourceRef() { return state.sourceRef; }, get subscriptionId() { return state.subscriptionId; },
    assertCurrent() { assert(state.trusted, 'fixture_source_revoked'); },
    async subscribe(eventType, receive, gap) {
      assert.equal(eventType, 'state_changed'); state.receive = receive; state.gap = gap;
      return () => { state.unsubscribes++; };
    }, close() { state.closes++; },
  };
  const service = createHaEventService({ sourceRef, entries: [{ domain: 'jessica-vacuum', entityIds: entry.entityIds, prepareRequest,
    execute(input, current) {
      try { return execute ? execute(input, current, () => entry.execute(input, current)) : entry.execute(input, current); }
      catch (error) { state.domainFailures.push(error instanceof Error ? error.message : 'unknown'); throw error; }
    } }],
    async connect(signal) { state.connects++; state.signal = signal; return connection; },
    observe(result) { state.results.push(validateDomainResultEnvelope(result) as DomainResult); } });
  const context: Parameters<OpenClawPluginService['start']>[0] = { config: {}, stateDir: '/unused-fixture-state',
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    serviceHealth: { reportFailure() { state.failures++; }, clearFailure() {} } };
  return { state, service, context, connection, send(value: unknown = frame()) { state.receive(JSON.stringify(value)); } };
}

test('synthetic HA attribute-only warning crosses service, grant, domain, Response and DomainResult with no Run/effects', async () => {
  const f = fixture(); await f.service.start(f.context); f.send();
  assert.equal(f.state.results.length, 1, f.state.domainFailures.join(',')); assert(f.state.grants > 1); assert.equal(f.state.failures, 0);
  const result = f.state.results[0]!;
  assert.equal(result.executionMode, 'deterministic'); assert.equal(result.operation, 'warning');
  assert.deepEqual(result.outcome, boundedCopy({ disposition: 'handled', status: 'success' }));
  assert.deepEqual(result.facts.data, boundedCopy({ kind: 'device-warning', deviceEntity: VACUUM_ENTITY,
    condition: 'device-reports-error', active: true, severity: 'warning', observedAt: new Date(epoch - 1000).toISOString(),
    sourceKind: 'ha_event', taskCorrelation: 'unknown' }));
  assert.deepEqual(result.effects, boundedCopy({ status: 'none', refs: [], details: [], reconciliation: { required: false, reason: null } }));
  assert.equal(result.pendingContext, null); assert.equal(result.evidence.observations.length, 1);
  assert.match(result.content?.state === 'usable' ? result.content.text : '', /reports a device error.*correlation is unknown/);
  // Repeated observations are safe read results, not deduplicated send claims.
  f.send(); assert.equal(f.state.results.length, 2);
  assert.deepEqual(f.state.results[1], result);
  f.send(frame(false)); assert.equal(f.state.results[2]?.outcome.disposition, 'no-change');
  await f.service.stop?.(f.context);
  assert.equal(f.state.closes, 1); assert.equal(f.state.unsubscribes, 1); assert(f.state.signal?.aborted);
  f.send(); assert.equal(f.state.results.length, 3);
});

test('unmapped alias and foreign entity are not routed or granted', async () => {
  const f = fixture(); await f.service.start(f.context);
  f.send(frame(true, 'vacuum.jesica')); f.send(frame(true, 'vacuum.foreign'));
  assert.equal(f.state.grants, 0); assert.equal(f.state.results.length, 0);
  await f.service.stop?.(f.context);
});

for (const fault of ['unknown-version', 'legacy-raw-frame', 'extra-field', 'oversized-request', 'async-projection', 'revoked-during-projection'] as const) {
  test(`HA projection fails closed without fallback after ${fault}`, async () => {
    const f = fixture(raw => {
      if (fault === 'legacy-raw-frame') return JSON.stringify(raw);
      if (fault === 'oversized-request') return 'x'.repeat(8193);
      if (fault === 'async-projection') return Promise.resolve(prepareJessicaWarningEvent(raw)) as unknown as string;
      if (fault === 'revoked-during-projection') f.state.trusted = false;
      const projected = JSON.parse(prepareJessicaWarningEvent(raw)) as Record<string, unknown>;
      if (fault === 'unknown-version') projected.schemaVersion = 2;
      if (fault === 'extra-field') projected.unrelated = 'must-not-be-admitted';
      return JSON.stringify(projected);
    });
    await f.service.start(f.context); f.send();
    assert.equal(f.state.results.length, 0); assert.equal(f.state.failures, 1); assert.equal(f.state.closes, 1);
    if (['oversized-request', 'async-projection', 'revoked-during-projection'].includes(fault)) assert.equal(f.state.grants, 0);
    f.state.trusted = true; f.send(); assert.equal(f.state.results.length, 0);
    await f.service.stop?.(f.context);
  });
}

test('larger raw budget preserves structural bounds before domain projection', async () => {
  const f = fixture(); await f.service.start(f.context);
  const value = frame();
  Object.assign(value.event.data.new_state.attributes, { unrelated_telemetry: 'x'.repeat(16385) });
  assert(Buffer.byteLength(JSON.stringify(value)) < MAX_HA_EVENT_BYTES);
  f.send(value); assert.equal(f.state.failures, 1); assert.equal(f.state.grants, 0); assert.equal(f.state.results.length, 0);
  await f.service.stop?.(f.context);
});

for (const fault of ['custody', 'grant', 'subscription', 'malformed', 'oversized', 'wrong-event', 'device-mismatch',
  'missing-signal', 'nonboolean', 'stale', 'future', 'unavailable', 'gap'] as const) {
  test(`HA warning admission fails closed and never replays after ${fault}`, async () => {
    const f = fixture(); await f.service.start(f.context);
    const value = frame();
    if (fault === 'custody') f.state.trusted = false;
    if (fault === 'grant') f.state.granted = false;
    if (fault === 'subscription') value.id++;
    if (fault === 'wrong-event') value.event.event_type = 'call_service';
    if (fault === 'device-mismatch') value.event.data.new_state.entity_id = 'vacuum.foreign';
    if (fault === 'missing-signal') Reflect.deleteProperty(value.event.data.new_state.attributes, 'has_error');
    if (fault === 'nonboolean') value.event.data.new_state.attributes.has_error = 'true';
    if (fault === 'stale') value.event.data.new_state.last_updated = new Date(epoch - WARNING_EVENT_MAX_AGE_MS - 1).toISOString();
    if (fault === 'future') value.event.time_fired = new Date(epoch + 1).toISOString();
    if (fault === 'unavailable') value.event.data.new_state.state = 'unavailable';
    if (fault === 'gap') f.state.gap();
    if (fault === 'malformed') f.state.receive('{');
    else if (fault === 'oversized') f.state.receive('x'.repeat(MAX_HA_EVENT_BYTES + 1));
    else f.send(value);
    assert.equal(f.state.results.length, 0); assert(f.state.failures > 0);
    f.state.trusted = true; f.state.granted = true; f.send();
    assert.equal(f.state.results.length, 0); assert.equal(f.state.connects, 1);
    await f.service.stop?.(f.context);
  });
}

test('foreign source binding fails before subscribing', async () => {
  const f = fixture(); f.state.sourceRef = 'foreign';
  await assert.rejects(async () => f.service.start(f.context), /service_start_failed/);
  assert.equal(f.state.closes, 1); assert.equal(f.state.grants, 0);
  await f.service.stop?.(f.context);
});

test('stop during connect retires late connection and retained callbacks across restart', async () => {
  const f = fixture(); let release: ((connection: HaEventConnection) => void) | undefined;
  const service = createHaEventService({ sourceRef, entries: [], observe() { assert.fail('No results'); },
    connect: () => new Promise(resolve => { release = resolve; }) });
  const start = service.start(f.context); await service.stop?.(f.context);
  assert(release); release(f.connection); await start;
  assert.equal(f.state.closes, 1); assert.equal(f.state.unsubscribes, 0);
  await f.service.start(f.context); const old = f.state.receive;
  await assert.rejects(async () => f.service.start(f.context), /already_started/);
  await f.service.stop?.(f.context); await f.service.start(f.context);
  old(JSON.stringify(frame())); assert.equal(f.state.results.length, 0);
  f.send(); assert.equal(f.state.results.length, 1); await f.service.stop?.(f.context);
});

function observationFixture(scope: SourceInput['scope'] = 'read', sourceType: SourceInput['source']['type'] = 'ha') {
  const controller = createSourceAdmissionController({ now: () => epoch, assertCurrent() {}, assertDomainOutcome() {},
    readAuthority(input) { return { inputId: input.source.inputId, sourceType, sourceRef, domain: 'jessica-vacuum',
      subject: 'fixture-observer', authorityRef: 'fixture-grant', authorityRevision: '1', scopes: ['read', 'reconcile', 'notify', 'action'],
      expiresAt: epoch + 1, status: 'active', cancelled: false, replayState: 'fresh', commitment: 'uncommitted' }; } });
  const admission = controller.admit({ schemaVersion: 1, kind: 'benson.source-input',
    source: { type: sourceType, ref: sourceRef, inputId: 'fixture-event' }, domain: 'jessica-vacuum', scope, request: 'observation' });
  const outcome: NoRunOutcome = { schemaVersion: 1, kind: 'benson.no-run', disposition: 'handled', admission: {
    inputId: admission.source.inputId, sourceType, sourceRef, authorityRef: admission.authority.ref,
    authorityRevision: admission.authority.revision, domain: admission.domain, subject: admission.authority.subject },
    evidence: { ref: 'fixture-event', observedAt: new Date(epoch).toISOString(), freshness: 'fresh', facts: {} },
    effects: { status: 'none', refs: [] }, reconciliation: { required: false, reason: null }, notification: null, error: null };
  const normalizeFacts = () => ({ status: 'success', domain: admission.domain, domainSchemaVersion: '1', operation: 'warning',
    verified: true, verificationScope: ['fixture'], data: {}, warnings: [], error: null, effects: [], uncertainty: [], pendingContext: null });
  return { controller, admission, outcome, normalizeFacts };
}

test('v1 Response and DomainResult reject effects, notification, other sources and action scopes', () => {
  const cases = [observationFixture('action'), observationFixture('notify'), observationFixture('read', 'user'), observationFixture('read', 'automation')];
  const effects = observationFixture(); effects.outcome.effects = { status: 'known', refs: ['effect'] }; cases.push(effects);
  const reconcile = observationFixture(); reconcile.outcome.reconciliation = { required: true, reason: 'gap' }; cases.push(reconcile);
  const notify = observationFixture(); notify.outcome.notification = { identity: 'intent', policyRevision: '1', evidenceRef: 'fixture-event',
    route: { recipient: 'fixture-only', channel: 'fixture', accountId: 'fixture', target: 'fixture' }, content: 'do not send' }; cases.push(notify);
  for (const f of cases) {
    assert.throws(() => controlReadResponse(f.outcome, { ...f, renderOutcome: () => ({ schemaVersion: 2, message: 'observation' }) }), /observation_required/);
    assert.throws(() => createNoRunDomainResult({ mode: 'deterministic', outcome: f.outcome, rendered: { schemaVersion: 2, message: 'observation' } },
      { ...f, language: 'en' }), /observation_required/);
  }
});

for (const outcome of ['success', 'gap', 'stop', 'overlap', 'rejected'] as const) {
  test(`HA async entry retains source custody without queue/retry: ${outcome}`, async () => {
    let complete: (() => void) | undefined, invoked = 0;
    const f = fixture(prepareJessicaWarningEvent, (_input, current, run) => {
      invoked++; return new Promise<DomainResult>((resolve, reject) => { complete = () => {
        if (outcome === 'rejected') reject(new Error('fixture domain failure'));
        else { try { current(); resolve(run()); } catch (error) { reject(error); } }
      }; });
    });
    await f.service.start(f.context); f.send(); assert.equal(invoked, 1); assert.equal(f.state.results.length, 0);
    if (outcome === 'gap') f.state.gap();
    if (outcome === 'stop') await f.service.stop?.(f.context);
    if (outcome === 'overlap') { f.send(); assert.equal(invoked, 1); }
    assert(complete); complete(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.state.results.length, outcome === 'success' ? 1 : 0);
    assert.equal(f.state.connects, 1);
    await f.service.stop?.(f.context); assert.equal(f.state.closes, 1);
  });
}
