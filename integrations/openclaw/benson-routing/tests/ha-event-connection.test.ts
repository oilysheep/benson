import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import type { OpenClawPluginService } from 'openclaw/plugin-sdk/plugin-entry';
import { createHaEventConnector, type HaEventSocket } from '../adapters/openclaw/ha-event-connection.js';
import { createHaEventService, MAX_HA_EVENT_BYTES } from '../adapters/openclaw/ha-event-service.js';
import { createJessicaWarningEventEntry } from '../../../../agents/jessica-vacuum/lib/task.js';
import { loadRegistry } from '../../../../agents/jessica-vacuum/lib/registry.js';
import { VACUUM_ENTITY } from '../../../../agents/jessica-vacuum/lib/ha-read.js';
import { validateDomainResultEnvelope } from '../core/domain-result.js';
import type { DomainResult, SourceInput } from '../core/contracts.js';
import { plain } from '../core/value.js';

// Entirely in-memory transcript. The only credential is a synthetic string;
// no real endpoint, secret reader, model, Agent Run or effect port is supplied.
const epoch = Date.parse('2026-11-16T10:00:00Z'), sourceRef = 'synthetic-ha';
const registry = loadRegistry(JSON.parse(readFileSync('agents/jessica-vacuum/config/registry.v1.json', 'utf8')));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function warning() {
  return { id: 18, type: 'event', event: { event_type: 'state_changed', time_fired: new Date(epoch).toISOString(),
    data: { entity_id: VACUUM_ENTITY, new_state: { entity_id: VACUUM_ENTITY, state: 'cleaning',
      attributes: { has_error: true }, last_updated: new Date(epoch - 1000).toISOString() } } } };
}
function input(): SourceInput {
  return { schemaVersion: 1, kind: 'benson.source-input', domain: 'jessica-vacuum', scope: 'read',
    source: { type: 'ha', ref: sourceRef, inputId: 'synthetic-event' }, request: JSON.stringify(warning()) };
}
function fixture(options: { credential?: (signal: AbortSignal) => Promise<string>; timeout?: number } = {}) {
  let auth = deferred<void>(), subscription = deferred<void>();
  const state = { opens: 0, closes: 0, detaches: 0, credentialReads: 0, grants: 0, failures: 0,
    authorityFault: '', sendError: false, results: [] as DomainResult[], commands: [] as Record<string, unknown>[],
    signal: undefined as AbortSignal | undefined, handlers: undefined as Parameters<HaEventSocket['listen']>[0] | undefined };
  const socket: HaEventSocket = {
    listen(handlers) { state.handlers = handlers; return () => { state.detaches++; }; },
    send(raw) {
      if (state.sendError) throw new Error('synthetic-send-failure');
      const command = JSON.parse(raw) as Record<string, unknown>; state.commands.push(command);
      if (command.type === 'auth') auth.resolve();
      if (command.type === 'subscribe_events') subscription.resolve();
    }, close() { state.closes++; state.handlers?.close(); },
  };
  const connector = createHaEventConnector({ sourceRef, domain: 'jessica-vacuum', subscriptionId: 18,
    handshakeTimeoutMs: options.timeout ?? 10_000,
    createSocket(signal) {
      state.opens++; state.signal = signal; auth = deferred<void>(); subscription = deferred<void>(); return socket;
    },
    async readCredential(signal) { state.credentialReads++; return options.credential ? options.credential(signal) : 'synthetic-only-credential'; },
    readAuthority(value) {
      state.grants++;
      const grant = { inputId: value.source.inputId, sourceType: 'ha', sourceRef, domain: 'jessica-vacuum',
        subject: 'synthetic-observer', authorityRef: 'explicit-read-grant', authorityRevision: '1', scopes: ['read'],
        expiresAt: epoch + 60_000, status: 'active', cancelled: false, replayState: 'fresh', commitment: 'uncommitted' };
      switch (state.authorityFault) {
        case 'absent': return undefined;
        case 'revoked': grant.status = 'revoked'; break;
        case 'expired': grant.expiresAt = epoch; break;
        case 'source': grant.sourceRef = 'foreign'; break;
        case 'domain': grant.domain = 'reminder'; break;
        case 'scope': grant.scopes = ['action']; break;
        case 'replaced': if (state.grants > 1) grant.authorityRevision = '2'; break;
        case 'async': return Promise.resolve(grant);
      }
      return grant;
    } });
  const entry = createJessicaWarningEventEntry({ registry, now: () => epoch, readAuthority: connector.readAuthority });
  const service = createHaEventService({ sourceRef, connect: connector.connect,
    entries: [{ domain: 'jessica-vacuum', entityIds: entry.entityIds, prepareRequest: entry.prepareRequest, execute: entry.execute }],
    observe(result) { state.results.push(validateDomainResultEnvelope(result) as DomainResult); } });
  const context: Parameters<OpenClawPluginService['start']>[0] = { config: {}, stateDir: '/unused-synthetic-state',
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    serviceHealth: { reportFailure() { state.failures++; }, clearFailure() {} } };
  function emit(value: unknown) { assert(state.handlers); state.handlers.message(JSON.stringify(value)); }
  async function authenticate() {
    emit({ type: 'auth_required', ha_version: 'synthetic' }); await auth.promise;
    emit({ type: 'auth_ok', ha_version: 'synthetic' }); await subscription.promise;
  }
  async function start() {
    const started = service.start(context); await authenticate();
    emit({ id: 18, type: 'result', success: true, result: null }); await started;
  }
  return { state, socket, connector, service, context, emit, authenticate, start,
    get auth() { return auth; }, get subscription() { return subscription; } };
}

test('synthetic HA handshake and explicit grant reach existing event/domain/Response path', async () => {
  const f = fixture();
  assert.throws(() => f.connector.readAuthority(input()), /grant_unavailable/); assert.equal(f.state.grants, 0);
  await f.start();
  assert.deepEqual(f.state.commands.map(c => c.type), ['auth', 'subscribe_events']);
  assert.deepEqual(f.state.commands[1], { id: 18, type: 'subscribe_events', event_type: 'state_changed' });
  f.emit(warning()); assert.equal(f.state.results.length, 1); assert(f.state.grants > 1);
  const result = f.state.results[0]!;
  assert.equal(result.executionMode, 'deterministic'); assert.equal(result.operation, 'warning');
  assert.equal(result.outcome.disposition, 'handled'); assert.equal(result.effects.status, 'none');
  assert.deepEqual(result.effects.refs, []); assert.equal(result.pendingContext, null);
  assert(plain(result.facts.data)); assert.equal(result.facts.data.taskCorrelation, 'unknown'); assert.equal(f.state.failures, 0);
  await f.service.stop?.(f.context);
  assert.equal(f.state.closes, 1); assert.equal(f.state.detaches, 1); assert(f.state.signal?.aborted);
  assert.throws(() => f.connector.readAuthority(input()), /grant_unavailable/);
});

for (const fault of ['auth-invalid', 'premature-event', 'wrong-ack', 'negative-ack', 'binary', 'oversized', 'malformed'] as const) {
  test(`protocol fails closed at ${fault}`, async () => {
    const f = fixture(); const started = Promise.resolve(f.service.start(f.context));
    const rejected = assert.rejects(started, /ha_event_service_start_failed/);
    if (fault === 'auth-invalid') {
      f.emit({ type: 'auth_required' }); await f.auth.promise; f.emit({ type: 'auth_invalid', message: 'synthetic rejection' });
    } else {
      await f.authenticate();
      if (fault === 'premature-event') f.emit(warning());
      if (fault === 'wrong-ack') f.emit({ id: 19, type: 'result', success: true, result: null });
      if (fault === 'negative-ack') f.emit({ id: 18, type: 'result', success: false, error: { code: 'unauthorized' } });
      if (fault === 'binary') f.state.handlers!.message(new Uint8Array([123]));
      if (fault === 'oversized') f.state.handlers!.message('x'.repeat(MAX_HA_EVENT_BYTES + 1));
      if (fault === 'malformed') f.state.handlers!.message('{');
    }
    await rejected;
    assert.equal(f.state.results.length, 0); assert.equal(f.state.grants, 0); assert.equal(f.state.opens, 1);
    assert.equal(f.state.closes, 1); assert.equal(f.state.detaches, 1);
    f.emit(warning()); assert.equal(f.state.results.length, 0);
    await f.service.stop?.(f.context);
  });
}

for (const fault of ['absent', 'revoked', 'expired', 'source', 'domain', 'scope', 'replaced', 'async']) {
  test(`HA authentication does not bypass ${fault} Benson grant`, async () => {
    const f = fixture(); await f.start(); f.state.authorityFault = fault; f.emit(warning());
    assert.equal(f.state.results.length, 0); assert.equal(f.state.failures, 1); assert.equal(f.state.closes, 1);
    f.state.authorityFault = ''; f.emit(warning()); assert.equal(f.state.results.length, 0);
    assert.throws(() => f.connector.readAuthority(input()), /grant_unavailable/);
    await f.service.stop?.(f.context);
  });
}

for (const fault of ['source', 'domain', 'scope'] as const) {
  test(`connection grant binding denies foreign ${fault} before calling authority owner`, async () => {
    const f = fixture(); await f.start(); const value = input();
    if (fault === 'source') value.source.ref = 'foreign';
    if (fault === 'domain') value.domain = 'reminder';
    if (fault === 'scope') value.scope = 'notify';
    assert.throws(() => f.connector.readAuthority(value), /grant_unavailable/);
    assert.equal(f.state.grants, 0); assert.equal(f.state.closes, 1);
    f.emit(warning()); assert.equal(f.state.results.length, 0); await f.service.stop?.(f.context);
  });
}

test('credential wait is abortable and late credential cannot send after retirement', async () => {
  const credential = deferred<string>(), entered = deferred<void>();
  const f = fixture({ credential: async () => { entered.resolve(); return credential.promise; } });
  const started = Promise.resolve(f.service.start(f.context)); const rejected = assert.rejects(started, /service_start_failed/);
  f.emit({ type: 'auth_required' }); await entered.promise;
  await f.service.stop?.(f.context); await rejected;
  credential.resolve('synthetic-late-credential'); await setImmediate();
  assert.equal(f.state.commands.length, 0); assert.equal(f.state.closes, 1); assert(f.state.signal?.aborted);
});

test('explicit handshake deadline retires an unfinished credential wait', async () => {
  const credential = deferred<string>(); const f = fixture({ timeout: 1, credential: () => credential.promise });
  const started = Promise.resolve(f.service.start(f.context)); const rejected = assert.rejects(started, /service_start_failed/);
  f.emit({ type: 'auth_required' }); await rejected;
  assert.equal(f.state.opens, 1); assert.equal(f.state.closes, 1); assert.equal(f.state.grants, 0);
  credential.resolve('synthetic-late-credential'); await f.service.stop?.(f.context);
});

test('auth_ok alone cannot expose a grant while subscription ACK is missing', async () => {
  const f = fixture(); const started = Promise.resolve(f.service.start(f.context));
  const rejected = assert.rejects(started, /service_start_failed/); await f.authenticate();
  assert.throws(() => f.connector.readAuthority(input()), /grant_unavailable/); await rejected;
  assert.equal(f.state.grants, 0); assert.equal(f.state.closes, 1);
});

test('subscription ACK wait shares the explicit handshake deadline', async () => {
  const f = fixture({ timeout: 1 }); const started = Promise.resolve(f.service.start(f.context));
  const rejected = assert.rejects(started, /service_start_failed/); await f.authenticate(); await rejected;
  f.emit({ id: 18, type: 'result', success: true, result: null }); f.emit(warning());
  assert.equal(f.state.grants, 0); assert.equal(f.state.closes, 1); assert.equal(f.state.results.length, 0);
});

test('already-aborted and duplicate connection attempts create no extra socket', async () => {
  const f = fixture(); const abort = new AbortController(); abort.abort();
  await assert.rejects(f.connector.connect(abort.signal), /connection_unavailable/); assert.equal(f.state.opens, 0);
  await f.start();
  assert.throws(() => f.connector.connect(new AbortController().signal), /already_open/);
  assert.equal(f.state.opens, 1); await f.service.stop?.(f.context);
});

test('close/error, domain rejection and old callbacks retire custody without replay across restart', async () => {
  for (const fault of ['close', 'error', 'domain'] as const) {
    const f = fixture(); await f.start(); const old = f.state.handlers!;
    if (fault === 'domain') { const bad = warning(); bad.event.data.new_state.entity_id = 'vacuum.foreign'; f.emit(bad); }
    else old[fault]();
    assert.equal(f.state.failures, 1); assert.equal(f.state.closes, 1); assert.equal(f.state.results.length, 0);
    await f.service.stop?.(f.context); await f.start();
    old.message(JSON.stringify(warning())); old.close(); old.error();
    assert.equal(f.state.closes, 1); f.emit(warning()); assert.equal(f.state.results.length, 1);
    await f.service.stop?.(f.context); assert.equal(f.state.closes, 2);
  }
});

test('credential and send failures disclose no protocol payload or provider exception', async () => {
  for (const fault of ['credential', 'send']) {
    const f = fixture({ credential: async () => { if (fault === 'credential') throw new Error('synthetic-private-reason'); return 'synthetic-only-credential'; } });
    f.state.sendError = fault === 'send';
    const started = Promise.resolve(f.service.start(f.context)); const rejected = assert.rejects(started, /^Error: ha_event_service_start_failed$/);
    f.emit({ type: 'auth_required' }); await rejected;
    assert.equal(f.state.closes, 1); assert.equal(f.state.results.length, 0); assert.equal(f.state.commands.length, 0);
  }
});
