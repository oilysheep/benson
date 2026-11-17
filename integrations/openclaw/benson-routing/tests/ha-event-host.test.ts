import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import type { WebSocket as NativeSocket, ClientOptions } from 'openclaw/plugin-sdk/websocket-runtime';
import type { OpenClawPluginService } from 'openclaw/plugin-sdk/plugin-entry';
import { createHaEventHostBinding } from '../adapters/openclaw/ha-event-host.js';
import { createHaEventService, MAX_HA_EVENT_BYTES } from '../adapters/openclaw/ha-event-service.js';
import type { HaEventDiagnosticCode } from '../adapters/openclaw/ha-event-service.js';
import { createJessicaWarningEventEntry } from '../../../../agents/jessica-vacuum/lib/task.js';
import { loadRegistry } from '../../../../agents/jessica-vacuum/lib/registry.js';
import { VACUUM_ENTITY } from '../../../../agents/jessica-vacuum/lib/ha-read.js';
import { validateDomainResultEnvelope } from '../core/domain-result.js';
import type { DomainResult, SourceInput, SourceAdmission } from '../core/contracts.js';

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
  credential?: Host['readCredential']; diagnose?: Host['diagnose'] } = {}) {
  const opened = deferred<FakeSocket>(), auth = deferred<void>(), subscription = deferred<void>(), loading = deferred<void>();
  const revoked = new AbortController();
  const state = { time: epoch, loads: 0, credentials: 0, failures: 0, sockets: [] as FakeSocket[], results: [] as DomainResult[],
    diagnostics: [] as HaEventDiagnosticCode[], inputs: [] as (SourceInput | SourceAdmission)[], sendFault: false };
  const diagnose: NonNullable<Host['diagnose']> = code => { state.diagnostics.push(code); return options.diagnose?.(code); };
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
    now: () => state.time, subscriptionId: 18, handshakeTimeoutMs: 10_000, diagnose,
    async loadSocket() { state.loads++; loading.resolve(); return options.loadSocket ? options.loadSocket() : Constructor; },
    async readCredential(signal) { state.credentials++; return options.credential ? options.credential(signal) : 'synthetic-only'; } });
  const entry = createJessicaWarningEventEntry({ registry, now: () => state.time,
    readAuthority(input) { state.inputs.push(input); return host.readAuthority(input); } });
  const service = createHaEventService({ sourceRef: 'synthetic-ha', connect: host.connect, diagnose,
    entries: [{ domain: 'jessica-vacuum', entityIds: entry.entityIds, prepareRequest: entry.prepareRequest, execute: entry.execute }],
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

for (const active of [true, false]) {
  test(`attribute-rich HA frame reaches bounded admission with original identity: has_error=${active}`, async () => {
    const f = fixture(), socket = await f.start();
    const state = { ...f.warning(active).event.data.new_state,
      attributes: { has_error: active, unrelated_telemetry: 'synthetic-private-attribute'.repeat(480) } };
    const frame = { ...f.warning(active), event: { ...f.warning(active).event,
      data: { entity_id: VACUUM_ENTITY, old_state: state, new_state: state } } };
    const raw = JSON.stringify(frame);
    assert(Buffer.byteLength(raw) > 16_422);
    socket.frame(frame);
    assert.equal(f.state.results.length, 1);
    const result = f.state.results[0]!;
    const inputId = `ha-${createHash('sha256').update(raw).digest('hex')}`;
    assert.equal(result.outcome.disposition, active ? 'handled' : 'no-change');
    assert.equal(result.executionMode, 'deterministic');
    assert.equal(result.effects.status, 'none'); assert.deepEqual(result.effects.refs, []);
    assert.equal(result.evidence.observations[0]?.ref, inputId);
    assert(f.state.inputs.length > 0);
    for (const input of f.state.inputs) {
      assert.equal(input.source.inputId, inputId);
      assert(Buffer.byteLength(input.request) <= 8192);
      assert(!input.request.includes('unrelated_telemetry')); assert(!input.request.includes('synthetic-private-attribute'));
    }
    assert(!JSON.stringify(result).includes('synthetic-private-attribute'));
    assert.equal(f.state.failures, 0); await f.service.stop?.(f.context); assert.equal(socket.closes, 1);
  });
}

test('retirement diagnostics: subscribed idle source survives 29 and 120 seconds until its 125-second grant', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ grant: { expiresAt: epoch + 125_000 } }), socket = await f.start();
  assert.deepEqual(f.state.diagnostics, ['connector_authenticated', 'connector_subscribed']);
  for (const delta of [29_000, 91_000]) {
    f.state.time += delta; t.mock.timers.tick(delta);
    assert.equal(socket.closes, 0); assert.equal(f.state.failures, 0);
  }
  f.state.time += 5_000; t.mock.timers.tick(5_000);
  await setImmediate();
  assert.equal(f.state.diagnostics[2], 'host_grant_expired');
  assert.equal(socket.closes, 1); assert.equal(f.state.failures, 1);
  assert.equal(f.state.results.length, 0);
  await f.service.stop?.(f.context);
});

for (const [fault, expected] of [
  ['payload-limit', 'host_payload_limit'], ['socket-error', 'host_socket_error'],
  ['socket-close', 'host_socket_close'], ['protocol-json', 'connector_frame_json'],
  ['protocol-bounds', 'connector_frame_bounds'], ['protocol-sequence', 'connector_sequence'],
  ['event-shape', 'service_frame_shape'], ['domain', 'service_domain_failed'],
] as const) {
  test(`retirement diagnostics: first cause ${fault} stays sanitized and closes once`, async () => {
    const f = fixture(), socket = await f.start();
    const offset = f.state.diagnostics.length, secret = 'synthetic-private-payload-and-error';
    if (fault === 'payload-limit' || fault === 'socket-error') {
      socket.emit('error', Object.assign(new Error(secret), { code: fault === 'payload-limit' ? 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' : secret }));
    }
    if (fault === 'socket-close') socket.emit('close', 1006, Buffer.from(secret));
    if (fault === 'protocol-json') socket.emit('message', Buffer.from('{'+secret), false);
    if (fault === 'protocol-bounds') socket.frame({ type: 'event', id: 18, private: Array(257).fill(secret.slice(0, 1)) });
    if (fault === 'protocol-sequence') socket.frame({ type: secret });
    if (fault === 'event-shape') socket.frame({ type: 'event', id: 18, event: { event_type: secret } });
    if (fault === 'domain') {
      const frame = f.warning();
      socket.frame({ ...frame, event: { ...frame.event, data: { ...frame.event.data,
        new_state: { ...frame.event.data.new_state, attributes: { has_error: secret } } } } });
    }
    await setImmediate();
    assert.equal(f.state.diagnostics[offset], expected);
    assert.equal(f.state.failures, 1); assert.equal(socket.closes, 1); assert.equal(f.state.results.length, 0);
    socket.frame(f.warning()); await f.service.stop?.(f.context); await setImmediate();
    assert.equal(socket.closes, 1); assert.equal(f.state.results.length, 0);
    assert.ok(!JSON.stringify(f.state.diagnostics).includes(secret));
    assert.ok(f.state.diagnostics.every(code => typeof code === 'string'));
  });
}

for (const mode of ['throw', 'reject'] as const) {
  test(`retirement diagnostics: observer ${mode} cannot change retirement or leak details`, async () => {
    const f = fixture({ diagnose() {
      if (mode === 'throw') throw new Error('synthetic-private-diagnostic');
      return Promise.reject(new Error('synthetic-private-diagnostic'));
    } }), socket = await f.start();
    socket.emit('error', new Error('synthetic-private-native-error')); await setImmediate();
    assert.equal(f.state.diagnostics[2], 'host_socket_error');
    assert.equal(socket.closes, 1); assert.equal(f.state.failures, 1);
    assert.equal(f.state.results.length, 0); await f.service.stop?.(f.context);
  });
}

for (const [action, expected] of [
  ['fault', 'host_socket_error'], ['grant', 'connector_grant_rejected'], ['stop', 'service_stop'],
] as const) {
  test(`retirement diagnostics: reentrant ${action} observer cannot admit after retirement starts`, async () => {
    let socket: Awaited<ReturnType<ReturnType<typeof fixture>['start']>> | undefined;
    const f = fixture({ diagnose(code) { if (code === expected) socket?.frame(f.warning()); } });
    socket = await f.start();
    if (action === 'fault') socket.emit('error', new Error('synthetic-private-native-error'));
    if (action === 'grant') assert.throws(() => f.host.readAuthority({ ...f.input(), domain: 'reminder' }), /grant_unavailable/);
    if (action === 'stop') await f.service.stop?.(f.context);
    await setImmediate();
    assert.ok(f.state.diagnostics.includes(expected));
    assert.equal(f.state.results.length, 0); assert.equal(socket.closes, 1);
    await f.service.stop?.(f.context);
  });
}

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

test('larger receive budget preserves the 8KiB outbound auth command limit', async () => {
  const f = fixture({ async credential() { return 'x'.repeat(8192); } });
  const started = Promise.resolve(f.service.start(f.context)), rejected = assert.rejects(started, /service_start_failed/);
  const socket = await f.opened.promise; socket.frame({ type: 'auth_required' }); await rejected;
  assert.equal(socket.commands.length, 0); assert.equal(socket.closes, 1); assert.equal(f.state.credentials, 1);
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
