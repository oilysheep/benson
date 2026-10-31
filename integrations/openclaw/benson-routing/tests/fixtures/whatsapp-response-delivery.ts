import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';
import { AsyncResource } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { copyReplyPayloadMetadata } from 'openclaw/plugin-sdk/reply-payload';
import { getReplyFromConfig, type ReplyPayload } from 'openclaw/plugin-sdk/reply-runtime';
import { createMainResponseDelivery, createDirectReadResponseDelivery } from '../../core/response-control.js';
import { createSourceAdmissionController } from '../../core/request-control.js';
import { executeJessicaStatusTask } from '../../../../../agents/jessica-vacuum/lib/task.js';
import { resolveTrustedIdentity } from '../../../../../agents/jessica-vacuum/lib/identity.js';
import { createResponseEnvelope, createResponseV3Envelope } from '../../core/legacy-response.js';
import { validateDomainResult } from '../../core/domain-result.js';
import { createJessicaTaskToolFactory } from '../../../plugins/benson-jessica-tool/src/tool.js';
import { loadPolicy, authorize } from '../../../../../agents/jessica-vacuum/lib/policy.js';
import { DomainError } from '../../../../../agents/jessica-vacuum/lib/errors.js';
import { validateResult } from '../../../../../agents/jessica-vacuum/lib/results.js';
import { renderJessicaDomainResult } from '../../../../../agents/jessica-vacuum/lib/presentation.js';
import { plain, boundedCopy } from '../../core/value.js';
import { isolated, worker, writeReport } from './native-correlation.js';

type Dispatch = OpenClawPluginApi['runtime']['channel']['reply']['dispatchReplyFromConfig'];
type Dispatcher = Parameters<Dispatch>[0]['dispatcher'];
type NativeModule = {
  createBensonResponseDispatch(native: Dispatch, runtime: unknown, account: string, signal: AbortSignal): Dispatch;
  deliverWebReply(params: Record<string, unknown>): Promise<unknown>;
  normalizeWhatsAppSendResult(value: unknown, kind: string): unknown;
};

// Version-bound test transport seam, installed by --import before plugin loading.
// The monitor, stock listener, identity/ingress and delivery code stay original.
const monitorOnly = process.env.BENSON_NATIVE_WHATSAPP_MONITOR_ONLY === '1';
const installerOnly = process.env.BENSON_NATIVE_WHATSAPP_INSTALLER_ONLY === '1';
const transportSlot = '__bensonIsolatedWhatsAppSocketFactory';
const transportGlobal = globalThis as unknown as Record<string, unknown>;
if (monitorOnly && transportGlobal.__bensonIsolatedWhatsAppLoaderInstalled !== true) {
  isolated();
  transportGlobal.__bensonIsolatedWhatsAppLoaderInstalled = true;
  registerHooks({ load(url, context, nextLoad) {
    if (new URL(url).pathname.endsWith('/socket-close-DU7eerAa.mjs') && !new URL(url).searchParams.has('benson-original')) {
      const loaded = nextLoad(url, context);
      assert.equal(createHash('sha256').update(String(loaded.source)).digest('hex'), 'c54b159b54b59812995e90a02bcd38f543fe54a82ccc0dcd43c988bc2eeb6c93');
      return {
        format: 'module', shortCircuit: true,
        source: `export * from ${JSON.stringify(url + '?benson-original')};
        export const r = (...args) => {
          const factory = globalThis[${JSON.stringify(transportSlot)}];
          if (typeof factory !== 'function') throw new Error('Isolated socket factory unavailable');
          return factory(...args);
        };`,
      };
    }
    return nextLoad(url, context);
  } });
}

type BusinessProof = {
  clock: Date; reads: number; guards: (() => void)[];
  results: ReturnType<typeof validateDomainResult>[];
  calls: { callId: string; runId: string | undefined }[];
};

// Fixture consumer of the approved additive contract, not a business grant.
function readNativeHandoff(raw: unknown, expected: Record<string, unknown>) {
  assert(plain(raw) && Object.isFrozen(raw), 'Frozen native handoff required');
  assert.deepEqual(Reflect.ownKeys(raw).sort(), ['abortSignal', 'ctx']);
  assert(plain(raw.ctx)); assert(raw.abortSignal instanceof AbortSignal, 'Native dispatch signal required');
  const ctx = raw.ctx, abortSignal = raw.abortSignal;
  const keys = ['Provider', 'Surface', 'AccountId', 'SenderId', 'From', 'To', 'MessageSid', 'SessionKey'];
  const binding = Object.freeze(Object.fromEntries(keys.map(key => [key, expected[key]])));
  const assertCurrent = () => {
    abortSignal.throwIfAborted();
    for (const key of keys) assert.equal(ctx[key], binding[key], `Native handoff ${key} changed`);
  };
  assertCurrent();
  return Object.freeze({ ctx, abortSignal, assertCurrent });
}

async function monitorProof(api: OpenClawPluginApi, business: BusinessProof) {
  isolated();
  if (installerOnly) console.error('Isolated WhatsApp: loaded monitor proof');
  // Read-only test visibility into the host's actual registered, instance-wrapped
  // entry. Never unwrap it or synthesize its plugin/lifecycle authority.
  const registryUrl = '/repo/node_modules/openclaw/dist/registry-loaded-BugfxX6l.mjs';
  const registry = await import(registryUrl) as { r(id: string): {
    plugin: { id: string; config: { resolveAccount(cfg: unknown, id: string): unknown };
      gateway: { startAccount(ctx: unknown): Promise<unknown> } };
    resolveChannelRuntime(): OpenClawPluginApi['runtime']['channel'];
    captureReadAuthority(): (() => boolean) | undefined;
  } | undefined };
  const registration = registry.r('whatsapp'); assert(registration);
  assert.equal(registration.plugin.id, 'whatsapp');
  const readAuthority = registration.captureReadAuthority();
  if (installerOnly) assert.equal(readAuthority?.(), true, 'Native official installation must establish live read authority');
  const channel = registration.resolveChannelRuntime();
  const cases: unknown[] = [];
  // Native durable ingress retains failed admissions. Independent account scopes
  // prevent one negative case's recovery row becoming another case's input.
  for (const [index, name] of ['success-and-duplicate', 'rejection', 'missing-binding', 'foreign-account',
    'disallowed-sender', 'retired-binding', 'model-fallback', 'cancel-after-resolution',
    ...installerOnly ? ['main-domain-read', 'direct-read', 'direct-read-failure', 'direct-denied', 'direct-revoked-read', 'direct-cancel-read',
      'direct-destination-changed', 'direct-duplicate', 'direct-payload-changed', 'direct-missing-authority'] : []].entries()) {
    const domainRead = name === 'main-domain-read';
    const directRead = name.startsWith('direct-');
    const accountId = `fixture-${index}`;
    const authDir = `/tmp/empty-fixture-auth/${accountId}`;
    const requestId = `native-monitor-${name}`;
    const key = { channelId: 'whatsapp', accountId, capability: 'benson.response-controller.v1' };
    const connected = Promise.withResolvers<void>();
    const accepted = Promise.withResolvers<void>();
    const resolved = Promise.withResolvers<void>();
    const abort = new AbortController();
    const sends: { jid: string; text: string }[] = [], contexts: unknown[] = [], statuses: unknown[] = [];
    const phases: string[] = [], errors: string[] = [];
    const ev = new EventEmitter(), ws = Object.assign(new EventEmitter(), { isClosed: false, isClosing: false,
      close() { ws.isClosed = true; ws.emit('close'); } });
    let sockets = 0, runId = '';
    let handoff: ReturnType<typeof readNativeHandoff> | undefined;
    let directEvidence: unknown;
    const terminalOutcomes: string[] = [];
    let emitSocket: (event: string, payload: unknown) => void = () => { throw new Error('Socket not created'); };
    ev.on('newListener', event => { if (event === 'connection.update') queueMicrotask(() => ev.emit('connection.update', { connection: 'open' })); });
    transportGlobal[transportSlot] = () => {
      assert.equal(++sockets, 1, 'No unexpected reconnect');
      // Baileys events originate in the socket's creating scope. Retain that actual
      // native scope instead of emitting under the test application's hook scope.
      emitSocket = AsyncResource.bind((event: string, payload: unknown) => { ev.emit(event, payload); });
      return { ev, ws, user: { id: '15550000002:1@s.whatsapp.net', name: 'Fixture self' },
        async sendPresenceUpdate() {}, async readMessages() {}, async groupFetchAllParticipating() { return {}; },
        async sendMessage(jid: string, content: { text?: string }) {
          assert.equal(jid, '15550000001@s.whatsapp.net'); assert.equal(typeof content.text, 'string');
          sends.push({ jid, text: content.text! });
          accepted.resolve();
          return { key: { id: `native-monitor-receipt-${sends.length}`, remoteJid: jid, fromMe: true }, message: { conversation: content.text } };
        }, end() { ws.close(); },
      };
    };
    const binding = Object.freeze({ createTurn({ ctx, replyOptions }: { ctx: Record<string, unknown>; replyOptions: Record<string, unknown> }) {
        contexts.push(Object.fromEntries(['Provider', 'Surface', 'AccountId', 'SenderId', 'From', 'To', 'MessageSid', 'SessionKey'].map(key => [key, ctx[key]])));
        assert.equal(ctx.Provider, 'whatsapp'); assert.equal(ctx.AccountId, accountId);
        assert.equal(ctx.Surface, 'whatsapp'); assert.equal(ctx.SenderId, '+15550000001');
        assert.equal(ctx.From, '+15550000001'); assert.equal(ctx.To, '+15550000002');
        assert.equal(ctx.SessionKey, 'agent:main:main'); assert.equal(ctx.MessageSid, requestId);
        phases.push('controller-created');
        if (directRead) {
          // This fixture qualifies admission/Response integration for an explicitly
          // bound status capability. It does not classify text or prove Decision.
          let delivery: ReturnType<typeof createDirectReadResponseDelivery> | undefined;
          let executionLive = false, reads = 0, revocationInstalled = false;
          let policy = loadPolicy({ version: '1', defaultDecision: 'deny', rules: name === 'direct-denied' ? [] :
            [{ subject: 'reader', actionClass: 'read', deviceScope: 'jessica-vacuum', decision: 'allow' }] });
          const assertNativeCurrent = () => {
            isolated(); abort.signal.throwIfAborted(); assert(handoff); handoff.assertCurrent();
            assert.equal(readAuthority?.(), true); assert.notEqual(name, 'direct-missing-authority');
            assert.equal(channel.runtimeContexts.get(key), binding);
          };
          return Object.freeze({
            beforeNativeDeliver(payload: ReplyPayload, info: { kind: string }) {
              const candidate = name === 'direct-payload-changed' ? { text: 'Unapproved replacement' } : payload;
              const approved = delivery?.beforeNativeDeliver(candidate, info) ?? null;
              if (name === 'direct-duplicate' && approved) assert.equal(delivery?.beforeNativeDeliver(candidate, info), null);
              return approved;
            },
            async resolve(_resolveOriginal: () => Promise<unknown>, rawHandoff: unknown) {
              phases.push('resolver-start');
              try {
                handoff = readNativeHandoff(rawHandoff, ctx);
                if (name === 'direct-destination-changed') {
                  // Negative-only fixture copy permits post-preparation route
                  // drift without ever mutating the actual native context.
                  handoff = readNativeHandoff(Object.freeze({ ctx: { ...handoff.ctx }, abortSignal: handoff.abortSignal }), ctx);
                }
                assertNativeCurrent();
                const native = handoff.ctx;
                assert.equal(typeof native.MessageSid, 'string'); assert.equal(typeof native.From, 'string');
                assert.equal(typeof native.SenderId, 'string');
                const identity = resolveTrustedIdentity({ channel: 'whatsapp', accountId, to: native.From as string,
                  senderId: native.SenderId as string }, { accountId, approvedIds: ['reader'],
                  subjectForRoute: route => route === '+15550000001' ? 'reader' : null });
                const assertAuthorized = () => { assertNativeCurrent(); authorize(policy, identity, 'read'); };
                const controller = createSourceAdmissionController({
                  nativeDispatch: { requestId: native.MessageSid as string, domain: 'jessica-vacuum', subject: identity.senderId },
                  now: () => business.clock.getTime(),
                  assertCurrent() { assert(executionLive, 'Read scope retired'); assertAuthorized(); },
                  assertDomainOutcome(outcome) { const facts = validateResult(outcome.evidence.facts, null, business.clock);
                    assert.equal(facts.operation, 'status'); assert.equal(outcome.disposition, facts.status === 'success' ? 'handled' : 'failed'); },
                });
                executionLive = true;
                const admission = controller.admit({ schemaVersion: 3, kind: 'benson.source-input', domain: 'jessica-vacuum',
                  scope: 'read', request: JSON.stringify({ operation: 'status' }) });
                let result: ReturnType<typeof validateDomainResult>;
                try {
                  result = await executeJessicaStatusTask({ controller, admission }, { operation: 'status' }, {
                    identity, clock: () => business.clock,
                    authority: { signal: handoff.abortSignal, assertCurrent: () => controller.assertCurrent(admission) },
                    async read(_request, _identity, authority) {
                      authority.assertCurrent(); await Promise.resolve(); authority.assertCurrent(); reads++;
                      if (name === 'direct-revoked-read') {
                        policy = loadPolicy({ version: '1', defaultDecision: 'deny', rules: [] });
                        revocationInstalled = true;
                      }
                      if (name === 'direct-cancel-read') abort.abort();
                      authority.assertCurrent();
                      const at = business.clock.toISOString();
                      if (name === 'direct-read-failure') return validateResult({ schemaVersion: '1', domain: 'jessica-vacuum',
                        operation: 'status', status: 'failure', verified: false, data: null, warnings: [], pendingContext: null,
                        error: { code: 'BACKEND_UNAVAILABLE', stage: 'verification', retryable: true, retryMode: 'read_only',
                          sideEffects: 'none', message: 'Status could not be verified' } }, null, business.clock);
                      return validateResult({ schemaVersion: '1', domain: 'jessica-vacuum', operation: 'status', status: 'success', verified: true,
                        data: { kind: 'status', observedAt: at, sourceUpdatedAt: at, freshness: 'fresh', state: 'docked', batteryLevel: 100,
                          activeSegments: [], currentSegment: null }, warnings: [], error: null, pendingContext: null }, null, business.clock);
                    },
                  });
                } finally { executionLive = false; }
                assert.throws(() => controller.assertCurrent(admission), /Read scope retired/);
                const source = { type: 'direct' as const, executionMode: 'deterministic' as const, agentId: 'jessica-vacuum',
                  admission: { authorityKind: 'native-dispatch' as const, requestId: admission.requestId,
                    domain: admission.domain, subject: admission.authority.subject } };
                const response = createResponseV3Envelope({ messageCandidate: null }, { requestId, source, results: [result],
                  lifecycle: { domainExecution: 'attempted', failure: null },
                  responsePolicy: { preferredMode: 'deterministic', allowedModes: ['deterministic'] } });
                delivery = createDirectReadResponseDelivery({ mode: 'native-resolver', requestId, agentId: 'jessica-vacuum', admission,
                  assertCurrent: assertAuthorized, responseFor: () => response,
                  presentation: { language: 'he', now: business.clock.toISOString(), timezone: 'Asia/Jerusalem',
                    renderDomainResult: renderJessicaDomainResult,
                    assertResponseCurrent(value) { assertAuthorized(); assert.deepEqual(boundedCopy(value.source), boundedCopy(source)); assert.deepEqual(value.results, [result]); } },
                });
                directEvidence = { reads, result, admission: source.admission, readScopeRetired: true, originalResolverCalls: 0 };
                const prepared = await delivery.resolveNativeCandidate({ signal: handoff.abortSignal,
                  resolve: async () => { assert(result.content?.state === 'usable'); return { text: result.content.text }; },
                  copyMetadata: (source, approved) => copyReplyPayloadMetadata(source as ReplyPayload, approved) });
                if (name === 'direct-destination-changed') handoff.ctx.From = '+15550000003';
                return prepared;
              } catch (error) {
                directEvidence ??= { reads, rejected: true, revocationInstalled,
                  failure: error instanceof DomainError ? { code: error.code, stage: error.stage } : null };
                errors.push(String(error)); throw error;
              }
              finally { executionLive = false; directEvidence ??= { reads, rejected: true };
                phases.push('controller-settled'); resolved.resolve(); }
            },
          });
        }
        const original = replyOptions.onAgentRunStart;
        replyOptions.onAgentRunStart = (id: string) => { runId = id; if (typeof original === 'function') original(id); };
        replyOptions.disableTools = !domainRead;
        const originalTerminal = replyOptions.onAgentRunTerminalOutcome;
        replyOptions.onAgentRunTerminalOutcome = (outcome: string) => {
          terminalOutcomes.push(outcome); if (typeof originalTerminal === 'function') originalTerminal(outcome);
        };
        const delivery = createMainResponseDelivery({ mode: 'native-resolver', requestId, agentId: 'main', runId: () => runId,
          assertCurrent: () => { isolated(); abort.signal.throwIfAborted(); assert.notEqual(name, 'rejection');
            assert(handoff); handoff.assertCurrent();
            if (installerOnly) assert.equal(readAuthority?.(), true, 'Native plugin authority must remain current at Controller boundaries');
            assert(channel.runtimeContexts.get(key) === binding, 'Controller binding must remain current'); },
          responseFor: raw => {
            assert(plain(raw)); assert.equal(typeof raw.text, 'string');
            if (domainRead) {
              assert.deepEqual(terminalOutcomes, ['completed']);
              assert.equal(business.calls.length, 1); assert.equal(business.calls[0]?.runId, runId);
              assert.equal(business.results.length, 1); assert.equal(business.reads, 1);
              return createResponseV3Envelope({ messageCandidate: null }, { requestId,
                source: { type: 'main', agentId: 'main', runId }, results: business.results,
                lifecycle: { domainExecution: 'attempted', failure: null },
                responsePolicy: { preferredMode: 'deterministic', allowedModes: ['deterministic'] } });
            }
            return createResponseEnvelope({ messageCandidate: { text: raw.text as string, language: 'en' } }, {
              requestId, source: { type: 'main', agentId: 'main', runId }, status: 'success', results: [], pendingContext: null,
              provenance: { executionVerified: 'not_applicable', completionCorrelated: false }, lifecycle: { domainExecution: 'none', failure: null },
              responsePolicy: { preferredMode: 'pass_through', allowedModes: ['pass_through', 'safe_failure'] },
            });
          }, presentation: { language: domainRead ? 'he' : 'en', now: business.clock.toISOString(), timezone: 'Asia/Jerusalem',
            renderDomainResult: renderJessicaDomainResult,
            assertResponseCurrent(response) {
              assert(domainRead); assert.equal(response.requestId, requestId);
              assert.equal(response.source.type, 'main'); assert.equal(response.source.runId, runId);
              assert.deepEqual(response.results, business.results); assert.equal(business.results.length, 1);
              assert.equal(response.results[0]?.evidence.observations[0]?.ref, business.calls[0]?.callId);
              assert.deepEqual(terminalOutcomes, ['completed']);
            } },
        });
        return Object.freeze({ beforeNativeDeliver: delivery.beforeNativeDeliver,
          resolve: async (resolve: () => Promise<unknown>, rawHandoff: unknown) => {
            phases.push('resolver-start');
            try {
              handoff = readNativeHandoff(rawHandoff, ctx);
              return await delivery.resolveNativeCandidate({ resolve: async () => {
                const candidate = await resolve();
                phases.push('native-candidate');
                if (name === 'retired-binding') lease?.dispose();
                if (name === 'cancel-after-resolution') abort.abort();
                return candidate;
              }, signal: handoff.abortSignal, copyMetadata: (source, approved) => copyReplyPayloadMetadata(source as ReplyPayload, approved) });
            } catch (error) { errors.push(String(error)); throw error; }
            finally { phases.push('controller-settled'); resolved.resolve(); }
          } });
      } });
    const lease = name === 'missing-binding' ? undefined : api.runtime.channel.runtimeContexts.register({ ...key,
      accountId: name === 'foreign-account' ? 'foreign' : accountId, context: binding });
    const monitor = registration.plugin.gateway.startAccount({ cfg: api.config,
      account: registration.plugin.config.resolveAccount(api.config, accountId), accountId,
      channelRuntime: channel, abortSignal: abort.signal,
      runtime: { log() {}, error(value: unknown) { errors.push(String(value)); }, exit() { throw new Error('Unexpected monitor exit'); } },
      getStatus: () => ({ accountId }), setStatus(status: Record<string, unknown>) {
        statuses.push({ connected: status.connected, running: status.running, busy: status.busy });
        if (status.connected) connected.resolve();
      } });
    let timer: NodeJS.Timeout;
    const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
      const logPath = `/tmp/openclaw/openclaw-${new Date().toISOString().slice(0, 10)}.log`;
      const nativeLogs = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n')
        .filter(line => line.includes('web-inbound') || line.includes('web-auto-reply')).slice(-6)
        .map(line => { const row = JSON.parse(line) as Record<string, unknown>; return { message: row['2'], detail: row['1'] }; }) : [];
      const error = new Error(`Monitor fixture deadline: ${JSON.stringify({ name, phases, errors, sockets, contexts, sends, statuses, nativeLogs,
        trustedReadOwner: registration.captureReadAuthority()?.() === true })}`);
      writeReport({ probe: 'FAIL', error: String(error) }); reject(error);
    }, 45_000); });
    // Failure propagation and bounded native completion are causal, never sleeps.
    try {
      await Promise.race([deadline, connected.promise, monitor.then(() => { throw new Error('Monitor stopped before connection'); })]);
      assert.equal(existsSync(`${authDir}/creds.json`), false);
      const incoming = { type: 'notify', messages: [{ key: { remoteJid: `${name === 'disallowed-sender' ? '15550000003' : '15550000001'}@s.whatsapp.net`, id: requestId, fromMe: false },
        message: { conversation: domainRead ? 'G3_MAIN_READ_JESSICA' : name === 'model-fallback' ? 'G3_TERMINAL_NATIVE_FALLBACK' : 'G3_BOUNDED_SUCCESS' },
        messageTimestamp: Math.floor(Date.now() / 1000), pushName: 'Fixture sender' }] };
      emitSocket('messages.upsert', incoming);
      const allowed = domainRead || name === 'direct-read' || name === 'direct-read-failure' || name === 'direct-duplicate' || name === 'success-and-duplicate' || name === 'model-fallback';
      if (allowed) {
        await Promise.race([deadline, accepted.promise,
          resolved.promise.then(() => { assert.deepEqual(errors, [], 'Controller resolution failed'); return accepted.promise; }),
          monitor.then(() => { throw new Error('Monitor stopped before delivery'); })]);
        if (name === 'success-and-duplicate' || name === 'direct-duplicate') emitSocket('messages.upsert', incoming);
      } else if (!['missing-binding', 'foreign-account', 'disallowed-sender'].includes(name)) {
        await Promise.race([deadline, resolved.promise]);
      }
      if (name !== 'cancel-after-resolution' && name !== 'direct-cancel-read') {
        const controller = channel.runtimeContexts.get({ channelId: 'whatsapp', accountId, capability: 'connection-controller' }) as { getActiveListener(): { close(): Promise<void> } };
        assert(controller); await Promise.race([deadline, controller.getActiveListener().close()]);
      } else await Promise.race([deadline, monitor]);
      assert.equal(contexts.length, ['missing-binding', 'foreign-account', 'disallowed-sender'].includes(name) ? 0 : 1,
        JSON.stringify({ name, sends, statuses, sockets })); assert.equal(sends.length, allowed ? 1 : 0, name);
      if (allowed) {
        const content = domainRead ? business.results[0]?.content : directRead && plain(directEvidence) && plain(directEvidence.result) ? validateDomainResult(directEvidence.result).content : null;
        if (directRead) assert(content?.state === 'usable');
        if (domainRead) assert(content?.state === 'usable');
        assert.deepEqual(sends, [{ jid: '15550000001@s.whatsapp.net',
          text: content?.state === 'usable' ? content.text : 'Native Main fixture reply.' }]);
      }
      if (domainRead) {
        assert.equal(business.guards.length, 1);
        assert.throws(business.guards[0]!, 'Retained native invocation must expire after the Main turn');
        assert.notEqual(sends[0]?.text, 'Fixture finished.', 'Model wording must not replace domain facts');
      }
      if (contexts.length && !directRead) assert(runId, name);
      if (directRead) { assert.equal(runId, ''); assert.deepEqual(terminalOutcomes, []); }
    } finally {
      clearTimeout(timer!); abort.abort();
      try { await monitor; } finally { lease?.dispose(); delete transportGlobal[transportSlot]; }
    }
    assert.equal(ws.isClosed, true); assert.equal(ev.listenerCount('messages.upsert'), 0);
    assert.equal(ev.listenerCount('connection.update'), 0);
    for (const capability of ['connection-controller', 'connection-owner-pending', 'benson.response-controller.v1']) {
      assert.equal(channel.runtimeContexts.get({ ...key, capability }), undefined, capability);
    }
    assert.deepEqual(statuses.at(-1), { connected: false, running: false, busy: false });
    assert.equal(existsSync(`${authDir}/creds.json`), false);
    cases.push({ name, sends, contexts, runId, sockets, phases, errors, stopped: true, leasesReleased: true,
      nativeHandoffReceived: handoff !== undefined,
      ...directRead ? { direct: directEvidence ?? { rejected: true } } : {},
      ...domainRead ? { business: { reads: business.reads, results: business.results, calls: business.calls,
        expiredInvocationBlocked: true, terminalOutcomes } } : {} });
  }
  let nativeInstall: unknown;
  if (installerOnly) {
    console.error('Isolated WhatsApp: monitor cases settled; native disable');
    nativeInstall = JSON.parse(readFileSync('/tmp/native-install-evidence.json', 'utf8'));
    assert.equal(readAuthority?.(), true, 'Monitor settlement must not retire plugin authority');
    try {
      await promisify(execFile)('/usr/bin/node', ['/repo/node_modules/openclaw/openclaw.mjs', 'plugins', 'disable', 'whatsapp'],
        { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
          // Native diagnostics only, under the fixture's secret-free namespace.
          env: { ...process.env, OPENCLAW_PLUGIN_LIFECYCLE_TRACE: '1' } });
    } catch (error) {
      // Disposable, secret-free CLI output must survive namespace cleanup;
      // a generic Error string loses whether failure was exit, signal or timeout.
      const details = plain(error) || error instanceof Error ? error as Error & {
        code?: unknown; signal?: unknown; killed?: unknown; stdout?: unknown; stderr?: unknown;
      } : undefined;
      throw new Error(`Isolated native disable failed: ${JSON.stringify({
        code: details?.code ?? null, signal: details?.signal ?? null, killed: details?.killed ?? null,
        completedMonitorCases: cases.length, authorityCurrent: readAuthority?.() ?? null,
        newlyCapturedAuthorityCurrent: registration.captureReadAuthority()?.() ?? null,
        stdout: typeof details?.stdout === 'string' ? details.stdout.slice(-12_000) : null,
        stderr: typeof details?.stderr === 'string' ? details.stderr.slice(-12_000) : null,
      })}`, { cause: error });
    }
    assert.equal(readAuthority?.(), false, 'Native plugin disable must retire previously captured authority');
    assert.notEqual(registration.captureReadAuthority()?.(), true, 'Retired entry must not mint live authority');
  }
  writeReport({ probe: 'PASS', G3: 'BLOCKED', whatsappPlugin: '2026.10.4', monitorAssembly: true,
    cases, trustedReadOwner: installerOnly ? true : readAuthority?.() === true,
    ...installerOnly ? { nativeInstall, authorityRetired: readAuthority?.() === false } : {},
    limits: 'Stock native plugin registration/monitor/listener with isolated socket only. No real server authentication or production authority.' });
}

export default {
  id: 'benson-jessica-tool',
  register(api: OpenClawPluginApi) {
    isolated();
    const business: BusinessProof = { clock: new Date(), reads: 0, guards: [], results: [], calls: [] };
    if (installerOnly) {
      api.on('before_tool_call', (event, context) => {
        assert.equal(event.toolName, 'jessica_task'); assert(context.runId && context.toolCallId);
        assert.equal(event.runId, context.runId); assert.equal(event.toolCallId, context.toolCallId);
        business.calls.push({ callId: context.toolCallId, runId: context.runId });
      });
      const policy = loadPolicy({ version: '1', defaultDecision: 'deny', rules: ['read', 'control'].map(actionClass => ({
        subject: 'reader', actionClass, deviceScope: 'jessica-vacuum', decision: 'allow' })) });
      // Disposable business policy/backend; native provenance alone grants neither.
      const create = createJessicaTaskToolFactory({ roster: { accountId: 'fixture-8', approvedIds: ['reader'],
        subjectForRoute: route => route === '+15550000001' ? 'reader' : null }, policy, clock: () => business.clock,
        async read(request, identity, authority) {
          assert.deepEqual(request, { operation: 'status' }); assert(plain(identity)); assert.equal(identity.senderId, 'reader');
          authority.assertCurrent(); business.guards.push(authority.assertCurrent);
          await Promise.resolve(); authority.assertCurrent(); business.reads++;
          const at = business.clock.toISOString();
          return validateResult({ schemaVersion: '1', domain: 'jessica-vacuum', operation: 'status', status: 'success', verified: true,
            data: { kind: 'status', observedAt: at, sourceUpdatedAt: at, freshness: 'fresh', state: 'docked', batteryLevel: 100,
              activeSegments: [], currentSegment: null }, warnings: [], error: null, pendingContext: null }, null, business.clock);
        }, jsonResult(raw) {
          const value = validateDomainResult(raw);
          return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
        } });
      api.registerTool({ contextVersion: 2, create(context) {
        const tool = create(context); if (!tool || Array.isArray(tool)) return tool;
        return { ...tool, async execute(callId, request, signal, onUpdate) {
          assert.equal(context.agentId, 'main'); assert.equal(context.deliveryContext?.channel, 'whatsapp');
          assert.equal(context.deliveryContext?.accountId, 'fixture-8');
          assert.equal(context.deliveryContext?.to, '+15550000001'); assert.equal(context.requesterSenderId, '+15550000001');
          assert.equal(business.calls.at(-1)?.callId, callId);
          const result = await tool.execute(callId, request, signal, onUpdate);
          // Custody starts only after the canonical factory's final live guard
          // succeeds; serialization alone is not a released DomainResult.
          context.assertInvocationCurrent();
          assert(plain(result)); business.results.push(validateDomainResult(result.details));
          return result;
        } };
      } });
    }
    const hookCalls = new Map<string, number>();
    api.on('message_sending', async () => {
      hookCalls.set(activeCase, (hookCalls.get(activeCase) ?? 0) + 1);
      if (activeCase === 'hook-error') throw new Error('Isolated hook failure');
      if (activeCase === 'hook-timeout') await new Promise(() => {});
      if (activeCase === 'hook-mutation') return { content: 'Unauthorized replacement' };
      return undefined;
    }, { timeoutMs: 10 });
    let activeCase = '';
    api.on('gateway_start', async () => {
      try {
        if (monitorOnly) { await monitorProof(api, business); return; }
        // Test-only visibility: no native behavior is replaced. The one-file patch
        // is mounted read-only; only private symbols are exported for this proof.
        registerHooks({ load(url, context, nextLoad) {
          const loaded = nextLoad(url, context);
          if (url.endsWith('/monitor-QPGSf7uJ.mjs')) return { ...loaded,
            source: String(loaded.source) + '\nexport { createBensonResponseDispatch, deliverWebReply, normalizeWhatsAppSendResult };\n' };
          return loaded;
        } });
        const moduleUrl = '/whatsapp/dist/.setup/monitor-QPGSf7uJ.mjs';
        const native = await import(moduleUrl) as NativeModule;
        const setterUrl = '/whatsapp/dist/runtime-setter-api.js';
        const setter = await import(setterUrl) as { setWhatsAppRuntime(runtime: OpenClawPluginApi['runtime']): void };
        setter.setWhatsAppRuntime(api.runtime);
        const cases: Record<string, unknown>[] = [];
        for (const name of ['success', 'rejection', 'missing-binding', 'resolver-error', 'cancel-before',
          'cancel-after-resolution', 'binding-replaced', 'duplicate', 'model-fallback', 'provider-error', 'native-timeout',
          'hook-mutation', 'hook-error', 'hook-timeout', 'async-turn', 'async-gate',
          'handoff-missing-signal', 'handoff-foreign-context', 'handoff-aborted-signal', 'handoff-retired-signal', 'legacy-consumer']) {
          activeCase = name;
          const abort = new AbortController(), sink: string[] = [], errors: string[] = [];
          const handoffAbort = new AbortController();
          const receipts: unknown[] = [];
          let runId = '', captured: Dispatcher | undefined;
          let handoff: ReturnType<typeof readNativeHandoff> | undefined;
          let nativeArgs: Parameters<typeof getReplyFromConfig> | undefined, forwarded = false, nativeGateCalls = 0;
          const requestId = `whatsapp-${name}`;
          const delivery = createMainResponseDelivery({ mode: 'native-resolver', requestId, agentId: 'main',
            runId: () => runId,
            assertCurrent: () => { isolated(); abort.signal.throwIfAborted(); assert.notEqual(name, 'rejection');
              if (name !== 'legacy-consumer') { assert(handoff); handoff.assertCurrent(); } },
            responseFor: raw => {
              assert(raw && typeof raw === 'object' && 'text' in raw && typeof raw.text === 'string');
              if ('isError' in raw && raw.isError === true) return createResponseEnvelope({ messageCandidate: null }, {
                requestId, source: { type: 'main', agentId: 'main', runId }, status: 'failure', results: [], pendingContext: null,
                provenance: { executionVerified: false, completionCorrelated: false },
                lifecycle: { domainExecution: 'uncertain', failure: { code: 'RUN_OUTCOME_UNRESOLVED' } },
                responsePolicy: { preferredMode: 'safe_failure', allowedModes: ['safe_failure'] },
              });
              return createResponseEnvelope({ messageCandidate: { text: raw.text, language: 'en' } }, {
                requestId, source: { type: 'main', agentId: 'main', runId }, status: 'success', results: [], pendingContext: null,
                provenance: { executionVerified: 'not_applicable', completionCorrelated: false },
                lifecycle: { domainExecution: 'none', failure: null },
                responsePolicy: { preferredMode: 'pass_through', allowedModes: ['pass_through', 'safe_failure'] },
              });
            }, presentation: { language: 'en', now: new Date().toISOString(), timezone: 'UTC' },
          });
          const key = { channelId: 'whatsapp', accountId: 'default', capability: 'benson.response-controller.v1' };
          const binding = Object.freeze({ createTurn({ ctx }: { ctx: Record<string, unknown> }) {
            if (name === 'async-turn') return Promise.reject(new Error('Invalid asynchronous Controller factory'));
            return Object.freeze({ beforeNativeDeliver(payload: unknown, info: { kind: string }) {
              if (name === 'async-gate') return Promise.reject(new Error('Invalid asynchronous Controller gate'));
              nativeGateCalls++; return delivery.beforeNativeDeliver(payload, info);
            },
              resolve: (resolve: () => Promise<unknown>, rawHandoff: unknown) => {
                let signal = abort.signal;
                // Explicit legacy consumer ignores the additive argument and
                // retains its previously accepted Main-only authority profile.
                if (name !== 'legacy-consumer') {
                  handoff = readNativeHandoff(rawHandoff, ctx); signal = handoff.abortSignal;
                  assert(nativeArgs); assert.equal(handoff.ctx, nativeArgs[0]);
                  assert.equal(handoff.abortSignal, nativeArgs[1]?.abortSignal);
                }
                return delivery.resolveNativeCandidate({
                resolve: async () => {
                  if (name === 'resolver-error') throw new Error('Isolated resolver failure');
                  const result = await resolve();
                  if (name === 'cancel-after-resolution') abort.abort();
                  if (name === 'binding-replaced') lease?.dispose();
                  return result;
                }, signal,
                copyMetadata: (source, approved) => copyReplyPayloadMetadata(source as ReplyPayload, approved),
              }).then(prepared => {
                // Retire after Controller preparation, so the final gate must
                // revalidate instead of trusting the earlier signal check.
                if (name === 'handoff-retired-signal') handoffAbort.abort(new Error('Isolated scope retirement'));
                return prepared;
              }); },
            });
          } });
          const lease = name === 'missing-binding' ? undefined : api.runtime.channel.runtimeContexts.register({ ...key, context: binding });
          const nativeDispatch: Dispatch = params => {
            captured = params.dispatcher; const resolver = params.replyResolver; assert(resolver);
            return api.runtime.channel.reply.dispatchReplyFromConfig({ ...params, replyResolver: (...args) => {
              // Negative-only boundary fault injection. Never alter native objects;
              // ordinary cases pass the actual final native argument references.
              if (name === 'handoff-missing-signal') {
                const options = { ...args[1] }; delete options.abortSignal; args = [args[0], options, args[2]];
              }
              if (name === 'handoff-foreign-context') args = [{ ...args[0], AccountId: 'foreign' }, args[1], args[2]];
              if (name === 'handoff-aborted-signal' || name === 'handoff-retired-signal') {
                if (name === 'handoff-aborted-signal') handoffAbort.abort(new Error('Isolated pre-aborted scope'));
                args = [args[0], { ...args[1], abortSignal: handoffAbort.signal }, args[2]];
              }
              nativeArgs = args;
              return resolver(...args);
            } });
          };
          const dispatch = native.createBensonResponseDispatch(nativeDispatch, api.runtime.channel, 'default', abort.signal);
          if (name === 'cancel-before') abort.abort();
          try {
            await api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({ cfg: api.config,
              ctx: { Body: name === 'model-fallback' ? 'G3_TERMINAL_NATIVE_FALLBACK' : name === 'provider-error'
                  ? 'G3_TERMINAL_PROVIDER_ERROR' : name === 'native-timeout' ? 'G3_TERMINAL_NATIVE_TIMEOUT' : 'G3_BOUNDED_SUCCESS',
                From: 'fixture-operator', To: 'fixture-sink', AgentId: 'main', SessionKey: `agent:main:${requestId}`,
                Provider: 'webchat', Surface: 'webchat', ChatType: 'direct', SenderId: 'fixture-operator', MessageSid: requestId },
              dispatcherOptions: { onError: error => { errors.push(String(error)); }, deliver: async (payload, info) => {
                assert.equal(info.kind, 'final');
                const receipt = await native.deliverWebReply({ replyResult: payload,
                  transport: { accountId: 'default', conversationId: '+15550000001', conversationKind: 'direct',
                    chatJid: '15550000001@s.whatsapp.net', recipientJid: '15550000002@s.whatsapp.net', correlationId: requestId,
                    reply: async (text: string) => {
                      sink.push(text);
                      return native.normalizeWhatsAppSendResult({ key: { id: `${requestId}-${sink.length}`,
                        remoteJid: '15550000001@s.whatsapp.net', fromMe: true } }, 'text');
                    } }, maxMediaBytes: 1024, textLimit: 4096, skipLog: true, tableMode: 'code', chunkMode: 'length',
                  replyLogger: { info() {}, warn() {}, debug() {}, error() {} },
                });
                assert(plain(receipt)); assert.equal(receipt.providerAccepted, true);
                assert(plain(receipt.receipt)); receipts.push(receipt.receipt);
              } }, replyResolver: (...args) => {
                assert(nativeArgs); assert.equal(args.length, nativeArgs.length);
                for (const [index, value] of args.entries()) assert.equal(value, nativeArgs[index]);
                forwarded = true; return getReplyFromConfig(...args);
              }, dispatchReplyFromConfig: dispatch,
              replyOptions: { disableTools: true, abortSignal: abort.signal, timeoutOverrideMs: name === 'native-timeout' ? 1000 : 5000,
                onAgentRunStart(id) { assert.equal(runId, ''); runId = id; } },
            });
            if (name === 'duplicate') {
              assert(captured); assert(sink[0]); captured.sendFinalReply({ text: sink[0] }); await captured.waitForIdle();
            }
          } catch (error) { errors.push(String(error)); }
          finally { lease?.dispose(); }
          const allowed = ['success', 'duplicate', 'model-fallback', 'provider-error', 'native-timeout', 'hook-error', 'hook-timeout', 'legacy-consumer'].includes(name);
          assert.equal(sink.length, allowed ? 1 : 0, JSON.stringify({ name, sink, errors, state: delivery.snapshot() }));
          assert.equal(receipts.length, sink.length);
          if (allowed) assert.deepEqual(errors, [], name);
          if (allowed) assert(forwarded && (handoff || name === 'legacy-consumer'), 'Original native arguments must be forwarded');
          if (name.startsWith('handoff-')) {
            if (name !== 'handoff-retired-signal') assert(errors.length > 0, name);
            else { assert(nativeGateCalls > 0); assert.equal(delivery.snapshot().outcome, 'blocked'); }
            assert.equal(forwarded, name === 'handoff-retired-signal', 'Invalid scope must block before resolver disclosure');
          }
          if (name.startsWith('hook-')) assert((hookCalls.get(name) ?? 0) > 0, 'native hook must actually run');
          if (name === 'provider-error' || name === 'native-timeout') {
            assert.equal(sink[0], 'I cannot verify a final outcome. The operation may have had effects; I will not repeat it automatically.');
          }
          cases.push({ name, deliveries: sink.length, receipts, hookCalls: hookCalls.get(name) ?? 0,
            errors, controller: delivery.snapshot(), nativeHandoffReceived: handoff !== undefined,
            originalArgumentsForwarded: forwarded, nativeGateCalls, injectedHandoffFault: name.startsWith('handoff-') });
        }
        writeReport({ probe: 'PASS', G3: 'BLOCKED', whatsappPlugin: '2026.10.4', cases,
          limits: 'Actual pinned WhatsApp delivery implementation with synthetic in-memory transport receipts. No real WhatsApp server, credentials, listener, registration or production authority proven.' });
      } catch (error) { writeReport({ probe: 'FAIL', error: String(error), stack: error instanceof Error ? error.stack : null }); }
    });
  },
};
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--worker') {
  void worker('whatsapp-response-delivery').catch(error => { console.error(error); process.exitCode = 1; });
}
