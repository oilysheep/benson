import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import type { WebSocket as NativeSocket, ClientOptions } from 'openclaw/plugin-sdk/websocket-runtime';
import type { OpenClawPluginService } from 'openclaw/plugin-sdk/plugin-entry';
import { createHaEventHostBinding } from '../adapters/openclaw/ha-event-host.js';
import { createHaEventService, MAX_HA_EVENT_BYTES } from '../adapters/openclaw/ha-event-service.js';
import { createJessicaWarningEventEntry } from '../../../../agents/jessica-vacuum/lib/task.js';
import { loadRegistry } from '../../../../agents/jessica-vacuum/lib/registry.js';
import { VACUUM_ENTITY } from '../../../../agents/jessica-vacuum/lib/ha-read.js';
import { validateDomainResultEnvelope } from '../core/domain-result.js';
import type { DomainResult, SourceInput } from '../core/contracts.js';

// Fake SDK constructor and synthetic credentials only. The default SDK loader,
// protected credential reader, real network, effects and model ports never run.
type Host = Parameters<typeof createHaEventHostBinding>[0];
const epoch = Date.parse('2026-11-16T11:00:00Z'), endpoint = 'ws://127.0.0.1:8123/api/websocket';
const registry = loadRegistry(JSON.parse(readFileSync('agents/jessica-vacuum/config/registry.v1.json', 'utf8')));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(options: { endpoint?: string; grant?: Partial<Host['grant']>; loadSocket?: Host['loadSocket'];
  credential?: Host['readCredential'] } = {}) {
  const opened = deferred<FakeSocket>(), auth = deferred<void>(), subscription = deferred<void>(), loading = deferred<void>();
  const revoked = new AbortController();
  const state = { time: epoch, loads: 0, credentials: 0, failures: 0, sockets: [] as FakeSocket[], results: [] as DomainResult[], sendFault: false };
  class FakeSocket extends EventEmitter {
    binaryType = '';
    closes = 0;
    commands: Record<string, unknown>[] = [];
    constructor(readonly address: string, readonly options: ClientOptions) {
      super(); state.sockets.push(this); opened.resolve(this);
    }
    send(raw: string, callback: (error?: Error) => void) {
      if (state.sendFault) { callback(new Error('synthetic private transport detail')); return; }
      const frame = JSON.parse(raw) as Record<string, unknown>; this.commands.push(frame);
      if (frame.type === 'auth') auth.resolve();
      if (frame.type === 'subscribe_events') subscription.resolve();
      callback();
    }
    terminate() { this.closes++; this.emit('close'); queueMicrotask(() => this.emit('error', new Error('synthetic late error'))); }
    frame(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
  }
  const Constructor = FakeSocket as unknown as typeof NativeSocket;
  const grant: Host['grant'] = { sourceType: 'ha', sourceRef: 'synthetic-ha', domain: 'jessica-vacuum',
    subject: 'explicit-monitor', authorityRef: 'operator-approved-source', authorityRevision: '1', scopes: ['read'],
    expiresAt: epoch + 60_000, status: 'active', cancelled: false, replayState: 'fresh', commitment: 'uncommitted', ...options.grant };
  const host = createHaEventHostBinding({ endpoint: options.endpoint ?? endpoint, grant, revoked: revoked.signal,
    now: () => state.time, subscriptionId: 18, handshakeTimeoutMs: 10_000,
    async loadSocket() { state.loads++; loading.resolve(); return options.loadSocket ? options.loadSocket() : Constructor; },
    async readCredential(signal) { state.credentials++; return options.credential ? options.credential(signal) : 'synthetic-only'; } });
  const entry = createJessicaWarningEventEntry({ registry, now: () => state.time, readAuthority: host.readAuthority });
  const service = createHaEventService({ sourceRef: 'synthetic-ha', connect: host.connect,
    entries: [{ domain: 'jessica-vacuum', entityIds: entry.entityIds, execute: entry.execute }],
    observe(result) { state.results.push(validateDomainResultEnvelope(result) as DomainResult); } });
  const context: Parameters<OpenClawPluginService['start']>[0] = { config: {}, stateDir: '/unused-synthetic-state',
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    serviceHealth: { reportFailure() { state.failures++; }, clearFailure() {} } };
  const warning = (active = true) => ({ id: 18, type: 'event', event: { event_type: 'state_changed',
    time_fired: new Date(state.time).toISOString(), data: { entity_id: VACUUM_ENTITY, new_state: { entity_id: VACUUM_ENTITY,
      state: 'docked', attributes: { has_error: active }, last_updated: new Date(state.time).toISOString() } } } });
  async function authenticate() {
    const socket = await opened.promise;
    socket.frame({ type: 'auth_required' }); await auth.promise;
    socket.frame({ type: 'auth_ok' }); await subscription.promise;
    return socket;
  }
  async function start() {
    const started = service.start(context), socket = await authenticate();
    socket.frame({ id: 18, type: 'result', success: true, result: null }); await started;
    return socket;
  }
  const input = (): SourceInput => ({ schemaVersion: 1, kind: 'benson.source-input', domain: 'jessica-vacuum', scope: 'read',
    source: { type: 'ha', ref: 'synthetic-ha', inputId: 'actual-event-ref' }, request: JSON.stringify(warning()) });
  return { host, service, context, state, start, authenticate, warning, input, grant, revoked, opened, loading, auth, Constructor };
}

test('host-bound synthetic SDK auth/subscription reaches warning and no-change DomainResults', async () => {
  const f = fixture(), socket = await f.start();
  assert.equal(socket.address, endpoint); assert.equal(socket.binaryType, 'nodebuffer');
  assert.deepEqual(socket.options, { maxPayload: MAX_HA_EVENT_BYTES, perMessageDeflate: false,
    followRedirects: false, handshakeTimeout: 10_000 });
  socket.frame(f.warning()); socket.frame(f.warning(false));
  assert.equal(f.state.results.length, 2);
  assert.deepEqual(f.state.results.map(result => result.outcome.disposition), ['handled', 'no-change']);
  for (const result of f.state.results) {
    assert.equal(result.executionMode, 'deterministic'); assert.equal(result.operation, 'warning');
    assert.equal(result.effects.status, 'none'); assert.deepEqual(result.effects.refs, []); assert.equal(result.pendingContext, null);
  }
  assert.deepEqual(f.host.readAuthority(f.input()), { ...f.grant, inputId: 'actual-event-ref' });
  assert.equal(f.state.credentials, 1);
  await f.service.stop?.(f.context);
  assert.equal(socket.closes, 1); assert.equal(socket.listenerCount('message'), 0);
  assert.throws(() => f.host.readAuthority(f.input()), /grant_unavailable/);
  await assert.rejects(f.host.connect(new AbortController().signal), /already_used/);
  assert.equal(f.state.loads, 1);
});

test('binding rejects foreign endpoints and non-read grants before any callback can run', () => {
  for (const value of ['ws://localhost:8123/api/websocket', endpoint + '?x=1', endpoint + '#x',
    'ws://user@127.0.0.1:8123/api/websocket', 'wss://example.invalid/api/websocket']) {
    assert.throws(() => fixture({ endpoint: value }), /binding_invalid/);
  }
  for (const grant of [{ sourceType: 'automation' as const }, { scopes: ['action' as const] },
    { scopes: ['read' as const, 'notify' as const] }, { subject: '' }, { authorityRevision: '' }]) {
    assert.throws(() => fixture({ grant }), /host_(?:grant|binding)_invalid/);
  }
});

test('grant fields are captured while revocation remains live and terminal', async () => {
  const f = fixture(), socket = await f.start();
  f.grant.sourceRef = 'foreign'; f.grant.subject = 'foreign'; f.grant.expiresAt = epoch + 9_000_000; f.grant.scopes.push('action');
  socket.frame(f.warning()); assert.equal(f.state.results.length, 1);
  f.revoked.abort(); socket.frame(f.warning());
  assert.equal(f.state.results.length, 1); assert.equal(f.state.failures, 1); assert.equal(socket.closes, 1);
  assert.doesNotThrow(() => socket.emit('error', new Error('synthetic late private error')));
  assert.throws(() => f.host.readAuthority(f.input()), /grant_unavailable/);
});

test('finite grant expiry retires an idle subscription without waiting for another event', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), socket = await f.start();
  f.state.time += 60_000; t.mock.timers.tick(60_000);
  assert.equal(socket.closes, 1); assert.equal(f.state.failures, 1);
  socket.frame(f.warning()); assert.equal(f.state.results.length, 0);
});

test('admission currentness rejects expired authority even before its timer runs', async () => {
  const f = fixture(), socket = await f.start(); f.state.time += 60_000;
  socket.frame(f.warning()); assert.equal(f.state.results.length, 0); assert.equal(socket.closes, 1);
});

test('subscription startup retains the original deadline across SDK loading', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const loading = deferred<typeof NativeSocket>(), f = fixture({ loadSocket: () => loading.promise });
  const started = Promise.resolve(f.service.start(f.context)), rejected = assert.rejects(started, /service_start_failed/);
  await f.loading.promise; t.mock.timers.tick(5_000); loading.resolve(f.Constructor);
  const socket = await f.authenticate();
  t.mock.timers.tick(5_000); await rejected;
  assert.equal(socket.closes, 1); assert.equal(f.state.results.length, 0);
});

test('successful subscription remains usable past the startup deadline until grant retirement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), socket = await f.start();
  f.state.time += 10_000; t.mock.timers.tick(10_000); socket.frame(f.warning());
  assert.equal(f.state.results.length, 1); assert.equal(socket.closes, 0);
  await f.service.stop?.(f.context);
});

test('already revoked, expired or oversized lifetimes perform no SDK or credential acquisition', async () => {
  for (const kind of ['revoked', 'expired', 'too-long', 'clock'] as const) {
    const f = fixture({ grant: { expiresAt: kind === 'expired' ? epoch : kind === 'too-long' ? epoch + 2_147_483_648 : epoch + 60_000 } });
    if (kind === 'revoked') f.revoked.abort();
    if (kind === 'clock') f.state.time = NaN;
    await assert.rejects(f.host.connect(new AbortController().signal), /^Error: ha_host_unavailable$/);
    assert.equal(f.state.loads, 0); assert.equal(f.state.credentials, 0);
  }
});

for (const cause of ['stop', 'revoke', 'deadline'] as const) {
  test(`${cause} settles a pending SDK load and a late constructor cannot open a socket`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const loading = deferred<typeof NativeSocket>(), f = fixture({ loadSocket: () => loading.promise });
    const started = Promise.resolve(f.service.start(f.context)); const rejected = assert.rejects(started, /service_start_failed/);
    await f.loading.promise;
    if (cause === 'stop') await f.service.stop?.(f.context);
    if (cause === 'revoke') f.revoked.abort();
    if (cause === 'deadline') t.mock.timers.tick(10_000);
    await rejected; loading.resolve(f.Constructor); await setImmediate();
    assert.equal(f.state.sockets.length, 0); assert.equal(f.state.credentials, 0);
  });
}

test('revocation during credential acquisition prevents late auth bytes and closes once', async () => {
  const token = deferred<string>(), acquired = deferred<AbortSignal>();
  const f = fixture({ credential(signal) { acquired.resolve(signal); return token.promise; } });
  const started = Promise.resolve(f.service.start(f.context)), rejected = assert.rejects(started, /service_start_failed/);
  const socket = await f.opened.promise; socket.frame({ type: 'auth_required' }); const signal = await acquired.promise;
  f.revoked.abort(); await rejected; assert(signal.aborted);
  token.resolve('synthetic-late-only'); await setImmediate();
  assert.equal(socket.commands.length, 0); assert.equal(socket.closes, 1);
});

for (const shape of ['binary', 'oversized', 'wrong-data-type'] as const) {
  test(`native ${shape} input is rejected before domain intake`, async () => {
    const f = fixture(), socket = await f.start();
    socket.emit('message', shape === 'wrong-data-type' ? '{}' : Buffer.alloc(shape === 'oversized' ? MAX_HA_EVENT_BYTES + 1 : 2), shape === 'binary');
    assert.equal(f.state.results.length, 0); assert.equal(f.state.failures, 1); assert.equal(socket.closes, 1);
  });
}

test('async SDK send failure retires custody without disclosing provider error', async () => {
  const f = fixture(); f.state.sendFault = true;
  const started = Promise.resolve(f.service.start(f.context)), rejected = assert.rejects(started, /^Error: ha_event_service_start_failed$/);
  const socket = await f.opened.promise; socket.frame({ type: 'auth_required' }); await rejected;
  assert.equal(socket.closes, 1); assert.equal(f.state.credentials, 1);
});

test('SDK load failure is sanitized and cannot acquire a credential', async () => {
  const f = fixture({ async loadSocket() { throw new Error('synthetic private loader detail'); } });
  await assert.rejects(f.host.connect(new AbortController().signal), /^Error: ha_host_unavailable$/);
  assert.equal(f.state.credentials, 0); assert.equal(f.state.sockets.length, 0);
});

test('HTTP redirect or connection error retires before credential acquisition', async () => {
  const f = fixture(), started = Promise.resolve(f.service.start(f.context));
  const rejected = assert.rejects(started, /service_start_failed/), socket = await f.opened.promise;
  // Native ws handles a redirect as an error with followRedirects:false.
  socket.emit('error', new Error('synthetic unexpected HTTP 302'));
  await rejected; assert.equal(f.state.credentials, 0); assert.equal(socket.closes, 1);
});
