import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { OpenClawPluginApi, OpenClawPluginToolFactory } from 'openclaw/plugin-sdk/plugin-entry';
import { createReplyDispatcher, dispatchInboundMessage, getReplyFromConfig } from 'openclaw/plugin-sdk/reply-runtime';
import { captureRuntimeConfigAsyncReader } from 'openclaw/plugin-sdk/runtime-config-snapshot';
import { createNativeMainRequestAdmission } from '../../adapters/openclaw/request.js';
import { loadIdentityContract } from '../../../../../agents/reminder-service/lib/identity.js';
import { loadPolicy } from '../../../../../agents/jessica-vacuum/lib/policy.js';
import { validateResult } from '../../../../../agents/jessica-vacuum/lib/results.js';
import { captureJessicaRequesterDelegation, createJessicaReadToolFactory, createJessicaTaskToolFactory,
  resolveJessicaRequesterDelegation } from '../../../plugins/benson-jessica-tool/src/tool.js';
import { plain } from '../../core/value.js';
import { currentNativeTurn } from '../../adapters/openclaw/response.js';
import { loadCanonicalIdentityContract } from '../../../plugins/benson-reminder-tool/src/identity.js';
import { VACUUM_ENTITY } from '../../../../../agents/jessica-vacuum/lib/ha-read.js';
import { isolated } from './native-correlation.js';
import { observeOpenClawToolExecution } from '../../adapters/openclaw/tool-execution-evidence.js';
import { readToolExecutionEvidence } from '../../core/tool-execution-evidence.js';
import { validateDomainResultEnvelope } from '../../core/domain-result.js';

// Observation/injected IO only. Native/Request owners remain the sole issuers.
type ResidentCase = { name: string; original: Record<string, string>; abort: AbortController;
  backend: number; results: number; parent: unknown[]; child: unknown[]; guards: (() => void)[];
  rejections: string[]; sourceGuards: (() => void)[]; retainedGuards: (() => void)[]; mainRuns: string[]; taskResults: unknown[] };
const residentPort = Symbol.for('benson.test.g1b.resident.io');
// Native plugin modules have isolated module caches. This test-only port shares
// observations and injected IO, never an issuer, grant or replacement registry.
function residentState(): { active?: ResidentCase; routing?: OpenClawPluginApi } {
  const value: unknown = Reflect.get(globalThis, residentPort); assert(plain(value)); return value;
}
function residentCase(): ResidentCase { const value = residentState().active; assert(value); return value; }
function residentRuntime(): OpenClawPluginApi { const value = residentState().routing; assert(value); return value; }
export function registerResidentAuthorityProof(api: OpenClawPluginApi,
  register: (api: OpenClawPluginApi) => void) {
  console.log(JSON.stringify({ residentRegistration: 'jessica', mode: api.registrationMode }));
  register({ ...api, logger: { ...api.logger, info(message) {
    // Only simulate loss/failure of observation. Successful cases use the real
    // native logger/file sink, not a fixture-built authority event.
    if (residentCase().name === 'missing-observer') return;
    if (residentCase().name === 'throwing-observer') throw new Error('fixture logger failure');
    api.logger.info(message);
  } }, resolvePath(path) {
    assert(['../../../../agents/reminder-service/config/recipients.json', '../../../../agents/jessica-vacuum/config/policy.v1.json',
      '../../../../agents/jessica-vacuum/config/registry.v1.json', '../../patches/tool-execution-receipts/manifest.json'].includes(path));
    return resolve('/repo/output/typescript/integrations/openclaw/plugins/benson-jessica-tool', path);
  }, registerTool(factory, options) {
    assert('contextVersion' in factory && factory.contextVersion === 2 && 'create' in factory);
    const create = factory.create;
    api.registerTool({ ...factory, create(ctx) {
      const tool = create(ctx); if (!tool || Array.isArray(tool)) return tool;
      return { ...tool, async execute(callId, args, signal, update) {
        if (ctx.agentId === 'main') {
          if (residentCase().name !== 'missing-binding') {
            const turn = currentNativeTurn(api, ctx), source = turn.source(ctx);
            residentCase().retainedGuards.push(() => turn.assertCurrent());
            assert.equal(source.request, residentCase().original.RawBody); const originalTurn = source.currentTurn(); assert(plain(originalTurn));
            assert.equal(originalTurn.entryId, residentCase().original.MessageSid);
            residentCase().sourceGuards.push(() => source.assertCurrent());
          }
          residentCase().parent.push({ callId, sessionKey: ctx.sessionKey, sessionId: ctx.sessionId });
          if (residentCase().name === 'catalog-parent-binding') {
            const sdk = '/repo/node_modules/openclaw/dist/';
            const { n: readTool } = await import(sdk + 'tool-execution-context-BwYF5HLu.mjs');
            const { o: readCaller } = await import(sdk + 'gateway-caller-context-4PMKhr4G.mjs');
            const native = readTool(), caller = readCaller();
            console.log(JSON.stringify({ nativeCatalogBinding: {
              outerToolIsDispatch: native?.toolCall?.name === 'dispatch_action',
              nativeCallMatchesTargetCall: native?.toolCall?.id === callId,
              operationalRunPresent: !!caller?.operationalRunInstance,
              agentMatches: caller?.agentId === ctx.agentId, sessionMatches: caller?.sessionKey === ctx.sessionKey,
              receiptAuthorityPresent: typeof caller?.receiptAuthority === 'function',
              receiptCurrent: typeof caller?.receiptAuthority === 'function' && caller.receiptAuthority() !== false,
            } }));
          }
        } else {
          const source = (ctx as unknown as { delegatedRequester: { parent: unknown; child: unknown;
            requester: { senderId: string }; assertCurrent(): void } }).delegatedRequester;
          assert.equal(source.requester.senderId, residentCase().original.SenderId);
          residentCase().child.push({ callId, parent: source.parent, child: source.child,
            requester: source.requester, workspace: ctx.workspaceDir });
          residentCase().guards.push(() => source.assertCurrent());
        }
        try { const value = await tool.execute(callId, args, signal, update);
          if (ctx.agentId === 'jessica-vacuum') {
            assert(plain(value.details) && value.details.status === 'success', 'native read must return actual success, not an error DTO');
            assert.equal(value.details.domain, 'jessica-vacuum'); assert.equal(value.details.operation, 'status');
            assert.equal(value.details.verified, true); residentCase().results++;
          } else residentCase().taskResults.push(value.details);
          return value;
        } catch (error) { residentCase().rejections.push(error instanceof Error ? error.message : String(error)); throw error; }
      } };
    } }, options);
  } });
}
export function retainResidentRouting(api: OpenClawPluginApi, register: (api: OpenClawPluginApi) => void) {
  console.log(JSON.stringify({ residentRegistration: 'routing', mode: api.registrationMode }));
  register({ ...api, resolvePath(path) {
    assert.equal(path, '../../../agents/reminder-service/config/recipients.json');
    return '/repo/output/typescript/agents/reminder-service/config/recipients.json';
  } });
  if (api.registrationMode === 'full') residentState().routing = api;
}

const id = 'benson-jessica-tool', text = 'NATIVE_MAIN_G1B: Read Jessica status.', accountId = 'g1b-fixture', peer = '+15550000001';
const identities = () => loadIdentityContract({ accountId, trustedRequesterIds: ['reader'],
  recipients: [{ id: 'reader', type: 'person', channel: 'whatsapp', to: peer }] });
const roster = { accountId, approvedIds: ['reader'], subjectForRoute: (route: string) => route === peer ? 'reader' : null };
const policy = () => loadPolicy({ version: '1', defaultDecision: 'deny', rules: ['read', 'control'].map(actionClass =>
  ({ subject: 'reader', actionClass, deviceScope: 'jessica-vacuum', decision: 'allow' })) });
type Scenario = { name: string; original: Record<string, string>; qualifyReceipts?: boolean };
const scenario = () => JSON.parse(readFileSync('/tmp/g1b-scenario.json', 'utf8')) as Scenario;
const receiptBatchSize = (mode: string) => mode === 'receipt-parallel-five' ? 5 :
  ['receipt-many', 'receipt-parallel-three', 'receipt-duplicate'].includes(mode) ? 3 : 1;
function observe(kind: string, value: unknown) {
  writeFileSync('/tmp/g1b-observations.jsonl', JSON.stringify({ kind, value }) + '\n', { flag: 'a', mode: 0o600 });
}

/** Disposable plugin composition; no Gateway hook, registry, or authority store.
 * The fixture host's original input DTO is NOT a grant. Main's independently
 * host-bound context must match it before canonical Benson admission; K11 then
 * mints authority from the actual native execution, never from the DTO.
 */
export function registerRequesterAuthorityProof(api: OpenClawPluginApi) {
  for (const name of ['jessica_execute', 'foreign_read']) api.registerTool({ contextVersion: 2, create(ctx) {
    if (ctx.agentId !== 'jessica-vacuum') return null;
    return { name, label: name, description: 'Forbidden proof tool', parameters: { type: 'object', properties: {} },
      async execute() { observe('unauthorized-backend', name); throw new Error('unauthorized backend entry'); } };
  } }, { name, optional: true });
  api.on('before_tool_call', (event, ctx) => {
    observe('before', { tool: event.toolName, callId: ctx.toolCallId,
      runId: ctx.runId, sessionId: ctx.sessionId, sessionKey: ctx.sessionKey, agentId: ctx.agentId });
    if (scenario().qualifyReceipts && scenario().name === 'receipt-blocked' && event.toolName === 'jessica_read')
      return { block: true, blockReason: 'Isolated pre-entry denial' };
    if (scenario().qualifyReceipts && scenario().name === 'receipt-adjusted' && event.toolName === 'jessica_read')
      return { params: { operation: 'status' } };
    return undefined;
  });
  api.on('after_tool_call', (event, ctx) => observe('after', { tool: event.toolName, callId: ctx.toolCallId,
    runId: ctx.runId, error: event.error, result: event.result }));
  api.registerTool({ contextVersion: 2, create(ctx) {
    if (ctx.agentId !== 'jessica-vacuum') return null;
    if (scenario().name === 'foreign-plugin') return null;
    const source = resolveJessicaRequesterDelegation(ctx, roster);
    if (!source) return null;
    const native = (ctx as unknown as { delegatedRequester: { parent: unknown; child: unknown; assertCurrent(): void } }).delegatedRequester;
    observe('child-binding', { parent: native.parent, child: native.child, workspace: ctx.workspaceDir });
    const tool = createJessicaReadToolFactory({ roster, policy: policy(), source,
      registryConfig: JSON.parse(readFileSync('/repo/agents/jessica-vacuum/config/registry.v1.json', 'utf8')),
      async read(request, identity, authority) {
        authority.signal.throwIfAborted(); authority.assertCurrent();
        assert(plain(identity)); assert.equal(identity.senderId, 'reader'); assert.deepEqual(request, { operation: 'status' });
        observe('read-entry', { sessionKey: ctx.sessionKey });
        const mode = scenario().name;
        if (mode === 'receipt-failed') throw new Error('Isolated read implementation failure');
        if (mode === 'revocation-latched') {
          writeFileSync('/tmp/revoked', 'deny'); await Promise.resolve();
          // Exercise the host accessor directly: no intervening Benson guard
          // may normalize the falsey throw or supply the revocation latch.
          assert.throws(() => native.assertCurrent()); unlinkSync('/tmp/revoked');
          assert.throws(() => native.assertCurrent()); observe('revocation-latched', true);
          throw new Error('fixture confirmed latched revocation');
        }
        if (mode === 'revoked-inflight' || mode === 'cancelled-inflight') {
          writeFileSync(mode === 'cancelled-inflight' ? '/tmp/cancelled' : '/tmp/revoked', 'deny');
          await Promise.resolve(); authority.signal.throwIfAborted(); authority.assertCurrent();
        }
        observe('backend-read', { requester: identity.senderId, agentId: ctx.agentId, sessionKey: ctx.sessionKey,
          sessionId: ctx.sessionId, parent: native.parent, child: native.child });
        if (mode === 'revoked-after-backend') { writeFileSync('/tmp/revoked', 'deny'); await Promise.resolve(); }
        const at = new Date().toISOString();
        return validateResult({ schemaVersion: '1', status: 'success', domain: 'jessica-vacuum', operation: 'status', verified: true,
          data: { kind: 'status', observedAt: at, sourceUpdatedAt: at, freshness: 'fresh', state: 'docked', batteryLevel: 90,
            activeSegments: [], currentSegment: null }, warnings: [], error: null, pendingContext: null });
      }, jsonResult(value) { observe('authorized-tool-result', { domain: value.domain, operation: value.operation });
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }; } })(ctx);
    assert(tool && !Array.isArray(tool));
    const parallel = ['receipt-parallel-three', 'receipt-parallel-five'].includes(scenario().name);
    const waiting = new Map<number, () => void>();
    return { ...tool, ...parallel ? { executionMode: 'parallel' as const } : {}, prepareArguments(input: unknown) {
      // Native preparation is not the admitted execute callback. Copied route
      // facts and a live Run alone must not authorize backend access here.
      assert.throws(() => source.authority.assertCurrent()); observe('outside-invocation-rejected', true);
      return input;
    }, async execute(callId, input, signal, update) {
      observe('child-tool-entry', { callId, sessionKey: ctx.sessionKey, sessionId: ctx.sessionId });
      try {
        const value = await tool.execute(callId, input, signal, update);
        if (parallel) {
          const ordinal = Number(callId.slice(callId.lastIndexOf('-') + 1));
          const gate = Promise.withResolvers<void>(); waiting.set(ordinal, gate.resolve);
          if (waiting.size === receiptBatchSize(scenario().name)) waiting.get(waiting.size - 1)!();
          await gate.promise;
          observe('parallel-return', ordinal); waiting.get(ordinal - 1)?.();
        }
        return value;
      }
      catch (error) { observe('child-rejection', error instanceof Error ? error.message : String(error)); throw error; }
    } };
  } }, { name: 'jessica_read', optional: true });
  api.registerTool({ contextVersion: 2, create(ctx) {
    if (ctx.agentId !== 'main') return null;
    let admission: ReturnType<typeof createNativeMainRequestAdmission> | undefined;
    const parentAbort = new AbortController();
    const source = () => {
      assert(admission); admission.assertCurrent(); ctx.assertInvocationCurrent();
      const { original } = scenario();
      return { request: original.RawBody!, binding: { conversationRef: original.SessionKey!, channel: 'whatsapp', accountId,
        kind: 'direct' as const, peerId: peer, threadId: null, requesterId: peer },
      currentTurn() { admission!.assertCurrent(); return { entryId: original.MessageSid!, role: 'user', text: original.RawBody!,
        sender: { source: 'canonical_peer_binding', id: peer, channel: 'whatsapp', accountId }, inputProvenance: { kind: 'external_user' } }; },
      assertCurrent() { admission!.assertCurrent(); }, assertAuthorized() { admission!.assertCurrent(); } };
    };
    const create = createJessicaTaskToolFactory({ roster, policy: policy(),
      read: async () => { throw new Error('G1(b) must use a fresh Domain Run'); },
      jsonResult() { throw new Error('G2_BLOCKED: no DomainResult release'); },
      task: { source,
        async run(_request, work) {
          const mode = scenario().name;
          const authority = work.execution.authority;
          const executeChild = async () => {
          const grant = captureJessicaRequesterDelegation(ctx, mode === 'revocation-latched' ? {
            signal: authority.signal, assertCurrent() {
              // This supplementary guard can only revoke existing authority.
              // Its falsey throw reaches K11 before canonical guards normalize it.
              if (existsSync('/tmp/revoked')) throw undefined;
              authority.assertCurrent();
            },
          } : authority);
          const child = { agentId: 'jessica-vacuum', sessionId: randomUUID(), runId: randomUUID(),
            sessionKey: `agent:jessica-vacuum:subagent:${randomUUID()}` };
          if (mode === 'foreign-domain') { child.agentId = 'main'; child.sessionKey = `agent:main:subagent:${randomUUID()}`; }
          if (mode === 'stale-parent') admission!.retire();
          if (mode === 'cancelled-parent') parentAbort.abort(new Error('fixture parent cancellation'));
          observe('delegation', { parentSessionId: ctx.sessionId, parentSessionKey: ctx.sessionKey, callId: work.callId, child });
          let sourceLive = true, dropReceipt = false;
          let interruptedSeal: boolean | undefined;
          let fault: (() => void) | undefined;
          if (scenario().qualifyReceipts && mode === 'receipt-concurrent') {
            const entry = 'openclaw/plugin-sdk/agent-core', sdk: unknown = await import(entry);
            const watch: unknown = Reflect.get(sdk as object, 'observeToolExecutionEvidence'); assert.equal(typeof watch, 'function');
            fault = (watch as (key: string, callback: (event: unknown) => void) => () => void)(child.sessionKey, event => {
              if (plain(event) && ['begin', 'seal'].includes(String(event.type)))
                observe('concurrent-run-event', { type: event.type, identity: event.identity });
            });
          }
          if (scenario().qualifyReceipts && mode === 'receipt-missing') {
            const entry = 'openclaw/plugin-sdk/agent-core', sdk: unknown = await import(entry);
            assert(plain(sdk) || typeof sdk === 'object' && sdk !== null);
            const watch: unknown = Reflect.get(sdk, 'observeToolExecutionEvidence'); assert.equal(typeof watch, 'function');
            fault = (watch as (key:string, callback:(event:unknown)=>void)=>()=>void)(child.sessionKey, event => {
              if (plain(event) && event.type === 'receipt') dropReceipt = true;
            });
          }
          const receipts = scenario().qualifyReceipts ? await observeOpenClawToolExecution(child.sessionKey,
            () => { authority.assertCurrent(); assert(sourceLive, 'fixture source retired');
              if (dropReceipt) { dropReceipt=false; throw new Error('Isolated receipt capture loss'); } },
            new URL('file:///repo/output/typescript/integrations/openclaw/patches/tool-execution-receipts/manifest.json')) : undefined;
          if (receipts && mode === 'positive') {
            const entry = 'openclaw/plugin-sdk/agent-core', sdk: unknown = await import(entry);
            const watch: unknown = Reflect.get(sdk as object, 'observeToolExecutionEvidence'); assert.equal(typeof watch, 'function');
            fault = (watch as (key: string, callback: (event: unknown) => void) => () => void)(child.sessionKey, event => {
              if (plain(event) && (event.type === 'begin' || event.type === 'seal')) {
                // Even publication of the terminal projection cannot authorize
                // consumption until native observers and logical scope settle.
                assert.throws(() => receipts.terminal(child.runId));
                observe('native-terminal-before-settlement-rejected', event.type);
              }
            });
          }
          if (receipts && mode === 'receipt-interrupted') {
            const entry = 'openclaw/plugin-sdk/agent-core', sdk: unknown = await import(entry);
            const watch: unknown = Reflect.get(sdk as object, 'observeToolExecutionEvidence'); assert.equal(typeof watch, 'function');
            fault = (watch as (key: string, callback: (event: unknown) => void) => () => void)(child.sessionKey, event => {
              if (!plain(event)) return;
              if (event.type === 'receipt') {
                assert.throws(() => receipts.terminal(child.runId));
                observe('native-unsealed-rejected', true);
                parentAbort.abort(new Error('fixture interrupted native child'));
              }
              if (event.type === 'seal') { interruptedSeal = event.complete as boolean;
                observe('native-interrupted-seal', { complete: event.complete }); }
            });
          }
          const background = api.lifecycle.runInBackgroundContext; assert(background);
          assert(ctx.sessionKey); const spawnedBy = ctx.sessionKey;
          await background(async () => {
            // The additional SDK field is supplied only to the exact K11 host.
            const params = { ...child, config: api.config, sessionPersistence: 'detached' as const,
              lane: 'subagent', spawnedBy,
              workspaceDir: '/tmp/jessica-workspace', agentDir: '/tmp/jessica-agent',
              prompt: 'NATIVE_JESSICA_G1B: Read status with jessica_read.', provider: 'fixture-local', model: 'g1b',
              timeoutMs: 20_000, abortSignal: work.execution.authority.signal,
              ...mode === 'missing-binding' ? {} : { requesterDelegation: mode === 'forged-grant' ? Object.freeze({}) :
                mode === 'cloned-grant' ? structuredClone(grant) : grant } };
            try { await api.runtime.agent.runEmbeddedAgent(params); }
            catch (error) { observe('native-rejection', { error: error instanceof Error ? error.message : String(error) });
              if (mode !== 'receipt-interrupted') throw error; }
            if (mode === 'duplicate-grant') {
              await assert.rejects(api.runtime.agent.runEmbeddedAgent({ ...params, sessionId: randomUUID(), runId: randomUUID(),
                sessionKey: `agent:jessica-vacuum:subagent:${randomUUID()}` }), /missing, foreign or already consumed/);
              observe('duplicate-rejected', true);
            }
          });
          if (receipts) {
            try {
              if (mode === 'receipt-interrupted') {
                assert.equal(parentAbort.signal.aborted, true);
                assert.equal(interruptedSeal, false, 'An actually interrupted native Run cannot publish complete coverage');
                assert.throws(() => receipts.terminal(child.runId));
                assert.throws(() => readToolExecutionEvidence(receipts.evidence(child.runId), child));
                observe('native-receipt-rejected', { mode, identity: child });
                return;
              }
              const identity = receipts.inspectIdentity(child.runId), evidence = receipts.evidence(child.runId);
              if (['receipt-duplicate','receipt-missing'].includes(mode)) {
                assert.throws(() => readToolExecutionEvidence(evidence, identity), /coverage_unverified/);
                observe('native-receipt-rejected', {mode,identity});
              } else {
                const coverage = readToolExecutionEvidence(evidence, identity);
                const expected = mode === 'receipt-zero' ? 0 : receiptBatchSize(mode);
                assert.equal(coverage.receipts.length, expected);
                for (const [ordinal, receipt] of coverage.receipts.entries()) {
                  assert.equal(receipt.ordinal, ordinal);
                  if (expected > 1) assert.equal(receipt.callId, `native-child-call-${ordinal}`);
                  assert.equal(receipt.name, mode === 'receipt-foreign-tool' ? 'jessica_execute' : 'jessica_read');
                  assert.equal(receipt.executionStarted, !['receipt-blocked','receipt-invalid-args','receipt-foreign-tool'].includes(mode));
                  assert.equal(receipt.isError, ['receipt-blocked','receipt-invalid-args','receipt-foreign-tool','receipt-failed'].includes(mode));
                  if (mode === 'receipt-adjusted') {
                    assert.deepEqual(JSON.parse(JSON.stringify(receipt.originalArgs)), { operation: 'rooms' });
                    assert.deepEqual(JSON.parse(JSON.stringify(receipt.executionArgs)), { operation: 'status' });
                  }
                }
                observe('native-receipt-seal', { mode,identity,seal:coverage.seal,receipts:coverage.receipts });
                const terminal = receipts.terminal(child.runId);
                assert.equal(terminal.runId, child.runId); assert.equal(terminal.sessionId, child.sessionId);
                assert.equal(terminal.sessionKey, child.sessionKey); assert.equal(terminal.success, true);
                assert(terminal.messages.some(message => plain(message) && message.role === 'assistant' && message.stopReason === 'stop'));
                observe('native-terminal-projection', { mode, terminal });
                assert.throws(() => readToolExecutionEvidence({}, identity), /missing/);
                assert.throws(() => readToolExecutionEvidence(evidence, { ...identity, runId: 'foreign-run' }));
                receipts.close();
                assert.deepEqual(readToolExecutionEvidence(evidence,identity),coverage);
                sourceLive=false;
                assert.throws(() => readToolExecutionEvidence(evidence,identity), /fixture source retired/);
              }
            } finally { receipts.dispose(); fault?.(); }
          }
          };
          if (mode === 'receipt-concurrent') await Promise.all([executeChild(), executeChild()]);
          else await executeChild();
          work.execution.authority.assertCurrent();
          throw new Error('G2_BLOCKED: native read is not controlled Completion');
        } } });
    const tool = create(ctx); assert(tool && !Array.isArray(tool));
    return { ...tool, async execute(callId, input, signal, update) {
      const { original } = scenario();
      assert.equal(ctx.sessionKey, original.SessionKey); assert.equal(ctx.requesterSenderId, original.SenderId);
      assert(ctx.deliveryContext); assert.equal(ctx.deliveryContext.channel, original.Provider); assert.equal(ctx.deliveryContext.accountId, original.AccountId);
      assert.equal(ctx.deliveryContext.to, original.From); ctx.assertInvocationCurrent();
      observe('parent-entry', { callId, sessionKey: ctx.sessionKey, sessionId: ctx.sessionId, requester: ctx.requesterSenderId });
      try {
      admission = createNativeMainRequestAdmission(identities(), original, () => {
        if (existsSync('/tmp/cancelled')) parentAbort.abort(new Error('fixture parent cancellation across await'));
        parentAbort.signal.throwIfAborted(); signal?.throwIfAborted(); ctx.assertInvocationCurrent();
        if (existsSync('/tmp/revoked')) throw new Error('fixture original source revoked');
      });
      admission.admit({ ...original });
      return await tool.execute(callId, input, AbortSignal.any([parentAbort.signal, ...signal ? [signal] : []]), update);
      } catch (error) { observe('parent-rejection', error instanceof Error ? error.message : String(error)); throw error; }
      finally { admission?.retire(); }
    } };
  } }, { name: 'jessica_task', optional: true });
}

/** Actual production entries and native tools, standalone host; no Gateway or
 * real credentials/channel/backend. Only the trusted ingress and IO are fake.
 */
/** Actual entry definitions through the installed native catalog presentation owner.
 * Schema construction only: this context cannot authorize tool execution. */
export async function directTaskEntryExposureWorker() {
  isolated();
  const tasks: Exclude<NonNullable<ReturnType<OpenClawPluginToolFactory<2>['create']>>, unknown[]>[] = [];
  for (const domain of ['jessica', 'reminder']) {
    const entry = (await import(`../../../plugins/benson-${domain}-tool/src/index.js`)).default;
    const register: unknown = entry.register; assert.equal(typeof register, 'function');
    if (typeof register !== 'function') assert.fail('Missing entry');
    register({ registrationMode: 'tool-discovery',
      resolvePath: (path: string) => resolve(`/repo/output/typescript/integrations/openclaw/plugins/benson-${domain}-tool`, path),
      registerTool(factory: OpenClawPluginToolFactory<2>) {
        const tool = factory.create({ agentId: 'main', assertInvocationCurrent() { assert.fail('Exposure-only context'); } });
        if (tool && !Array.isArray(tool)) tasks.push(tool);
      } });
  }
  assert.deepEqual(tasks.map(tool => tool.name).sort(), ['jessica_task', 'reminder_task']);
  const sdk = '/repo/node_modules/openclaw/dist/';
  const { m: createRef, n: controls, t: apply, a: directory } = await import(sdk + 'tool-search-eKe4Sl8B.mjs');
  let unrelatedExecutions = 0;
  const unrelated = { name: 'fixture_unrelated', label: 'Unrelated', description: 'Unrelated catalog capability',
    parameters: { type: 'object', properties: {} }, async execute() { unrelatedExecutions++; assert.fail('Exposure-only tool'); } };
  for (const setting of [undefined, true, { mode: 'directory' }]) {
    const catalogRef = createRef(), config = { tools: { ...setting === undefined ? {} : { toolSearch: setting } } };
    const ctx = { config, catalogRef }, nativeControls = controls(ctx);
    const result = (plain(setting) ? directory : apply)({ config, catalogRef, tools: [...tasks, unrelated, ...nativeControls] });
    for (const tool of tasks) {
      assert.equal(tool.catalogMode, 'direct-only');
      assert(result.tools.includes(tool), 'Task Entry must retain its direct native schema');
      assert(!catalogRef.current.entries.some((entry: { name: string }) => entry.name === tool.name));
      const dispatch = result.tools.find((entry: { name: string }) => entry.name === 'dispatch_action'); assert(dispatch);
      await assert.rejects(dispatch.execute('forged-wrapper', { id: tool.name, args: {} }), /already available directly/);
      const plugin = tool.name === 'jessica_task' ? 'benson-jessica-tool' : 'benson-reminder-tool';
      await assert.rejects(dispatch.execute('forged-wrapper', { id: `openclaw:${plugin}:${tool.name}`, args: {} }), /Unknown tool|not found/i);
    }
    assert(!result.tools.includes(unrelated));
    assert(catalogRef.current.entries.some((entry: { name: string }) => entry.name === unrelated.name));
    console.log(JSON.stringify({ nativeTaskExposure: 'PASS', setting: setting ?? 'automatic',
      direct: tasks.map(tool => tool.name), taskEntriesCataloged: 0, unrelatedRemainsCataloged: true }));
  }
  assert.equal(unrelatedExecutions, 0);
}

export async function residentWorker(bootstrapPlugins: (cfg: OpenClawPluginApi['config']) =>
  Promise<(run: () => Promise<void>) => Promise<void>>, flushLogs: () => Promise<void>,
  dispatchCall?: { id: string; args: Record<string, unknown> }, nativeToolSearch = false, g2 = false, g2Case = 'positive') {
  isolated();
  assert(['positive', 'cancelled-before-delivery', 'stale-before-delivery', 'revoked-before-delivery'].includes(g2Case));
  const identities = loadCanonicalIdentityContract('/repo/agents/reminder-service/config/recipients.json');
  const config: unknown = JSON.parse(readFileSync('/repo/agents/reminder-service/config/recipients.json', 'utf8'));
  assert(plain(config) && Array.isArray(config.recipients));
  const person = config.recipients.find(p => plain(p) && p.id === identities.trustedRequesterIds[0]);
  assert(plain(person) && typeof person.to === 'string');
  const personTo = person.to;
  const requestText = dispatchCall ? dispatchCall.args.request : text;
  assert.equal(typeof requestText, 'string');
  for (const path of ['/tmp/resident-jessica', '/tmp/resident-routing', '/tmp/main-workspace', '/tmp/jessica-workspace']) mkdirSync(path, { recursive: true });
  const io = residentPort;
  Reflect.set(globalThis, io, { async readCredential() {
    if (residentCase().name === 'cancelled-inflight') residentCase().abort.abort(new Error('resident cancellation'));
    return 'synthetic-fixture-only';
  }, async fetchImpl(url: string, options: RequestInit) {
    assert.equal(options.method, 'GET'); residentCase().backend++;
    const value = url.endsWith(`/api/states/${VACUUM_ENTITY}`) ? { entity_id: VACUUM_ENTITY, state: 'docked',
      attributes: { battery: 90, active_segments: [], current_segment: null }, last_updated: new Date().toISOString() } : [];
    if (residentCase().name === 'revoked-after-backend') residentCase().original.RawBody = 'retired source';
    return new Response(JSON.stringify(value), { status: 200 });
  } });
  // Load canonical entries in the Node graph where the existing transport's
  // injected ports can be intercepted. Native plugin loading isolates its module
  // cache; its tiny wrappers forward only registration through this test port.
  // All contexts, callbacks, tool guards and Run admission remain native-owned.
  const jessicaEntry = (await import('../../../plugins/benson-jessica-tool/src/index.js')).default;
  const routingEntry = (await import('../../src/index.js')).default;
  assert(jessicaEntry.register && routingEntry.register);
  Object.assign(Reflect.get(globalThis, io), {
    registerJessica(api: OpenClawPluginApi) { registerResidentAuthorityProof(api, jessicaEntry.register!); },
    registerRouting(api: OpenClawPluginApi) { retainResidentRouting(api, routingEntry.register!); },
  });
  for (const name of ['resident-jessica', 'resident-routing']) {
    const pluginId = name === 'resident-jessica' ? 'benson-jessica-tool' : 'benson-routing';
    writeFileSync(`/tmp/${name}/package.json`, JSON.stringify({ name: pluginId, version: '1.0.0', type: 'module', openclaw: { extensions: ['./index.js'] } }));
    writeFileSync(`/tmp/${name}/openclaw.plugin.json`, JSON.stringify({ id: pluginId, name, version: '1',
      activation: { onCapabilities: ['tool'], onAgentHarnesses: ['openclaw'] },
      contracts: { tools: name === 'resident-jessica' ? ['jessica_task', 'jessica_read', 'jessica_execute', 'jessica_validate_completion'] : [] },
      configSchema: { type: 'object', properties: {}, additionalProperties: false } }));
    writeFileSync(`/tmp/${name}/index.js`, `export default {id:'${pluginId}',register(api){
      globalThis[Symbol.for('benson.test.g1b.resident.io')].${name === 'resident-jessica' ? 'registerJessica' : 'registerRouting'}(api)}};`);
  }
  // The loader-selected package root must retain the production resource paths.
  // Resolve only those three config resources to the private compiled package.
  // No authority/registry replacement is involved.
  let requests = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += String(chunk);
    const input: unknown = JSON.parse(raw); assert(plain(input) && Array.isArray(input.tools) && Array.isArray(input.messages));
    const names = input.tools.map(t => { assert(plain(t) && plain(t.function) && typeof t.function.name === 'string'); return t.function.name; });
    const main = names.includes('jessica_task') || !!dispatchCall && names.includes('dispatch_action'),
      done = input.messages.some(m => plain(m) && m.role === 'tool');
    if (done && residentCase().name === 'unauthorized-tool' && !main) {
      const results = JSON.stringify(input.messages.filter(m => plain(m) && m.role === 'tool'));
      assert.match(results, /not found|not available|unknown tool/i); residentCase().rejections.push('native_unauthorized_tool_rejected');
    }
    if (!main && !done) {
      if (residentCase().name === 'stale-source') residentCase().original.RawBody = 'changed original source';
      if (residentCase().name === 'cancelled-parent') residentCase().abort.abort(new Error('resident parent cancellation'));
      if (residentCase().name === 'revoked-binding') residentRuntime().runtime.channel.runtimeContexts.register({ channelId: 'whatsapp',
        accountId: identities.accountId, capability: 'benson.response-controller.v1', context: Object.freeze({}), abortSignal: residentCase().abort.signal });
      assert(names.includes('jessica_read'), 'Delegated read requires its direct native schema');
      assert(names.every(name => ['jessica_read', ...nativeToolSearch
        ? ['dispatch_action', 'tool_describe', 'tool_search'] : []].includes(name)), 'Unexpected child tool');
    }
    let final = 'Unapproved native final/fallback.';
    if (g2 && !main && done) {
      const message = input.messages.findLast(m => plain(m) && m.role === 'tool'); assert(plain(message));
      assert.equal(typeof message.content, 'string');
      const value = validateResult(JSON.parse(String(message.content)), null, new Date());
      final = JSON.stringify({schemaVersion:6,kind:'domain-task',facts:{
        domain:value.domain,domainSchemaVersion:value.schemaVersion,operation:value.operation,
        status:value.status,verified:value.verified,verificationScope:value.verified?['status_read']:[],
        data:value.data,warnings:value.warnings,error:value.error,pendingContext:null,effects:[],uncertainty:[]
      },userResponse:{state:'usable',text:'Jessica נמצאת בתחנת העגינה.',language:'he'}});
    }
    const delta = done ? { content: final } : {
      tool_calls: [{ index: 0, id: main ? 'resident-parent-call' : 'resident-child-call', type: 'function', function: {
        name: main ? dispatchCall ? 'dispatch_action' : 'jessica_task' : residentCase().name === 'unauthorized-tool' ? 'jessica_execute' : 'jessica_read',
        arguments: JSON.stringify(main ? dispatchCall ?? { kind: 'benson.self-contained-request', version: 1, request: residentCase().original.RawBody }
          : { operation: 'status' }) } }] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const choice of [{ delta: { role: 'assistant' }, finish_reason: null }, { delta, finish_reason: null },
      { delta: {}, finish_reason: done ? 'stop' : 'tool_calls' }])
      res.write(`data: ${JSON.stringify({ id: `resident-${++requests}`, object: 'chat.completion.chunk', created: 1,
        model: 'g1b', choices: [{ index: 0, ...choice }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const logFile = '/tmp/g1b-native.log';
  const cfg: OpenClawPluginApi['config'] = { logging: { level: 'info', consoleLevel: 'silent', file: logFile },
    cron: { enabled: false }, discovery: { mdns: { mode: 'off' } },
    agents: { ownership: 'explicit', defaults: { systemAgent: { agentId: 'main' }, workspace: '/tmp/main-workspace',
      model: { primary: 'fixture-local/g1b' }, skipBootstrap: true }, entries: {
      main: { workspace: '/tmp/main-workspace', agentDir: '/tmp/main-agent', tools: { allow: ['jessica_task'], codeMode: false } },
      'jessica-vacuum': { workspace: '/tmp/jessica-workspace', agentDir: '/tmp/jessica-agent', tools: { allow: ['jessica_read'], codeMode: false } } } },
    tools: { allow: ['jessica_task', 'jessica_read'], toolSearch: nativeToolSearch || !!dispatchCall, codeMode: false },
    models: { providers: { 'fixture-local': { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'fixture-placeholder',
      authHeader: false, api: 'openai-completions', models: [{ id: 'g1b', name: 'Fixture', reasoning: false,
        input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 256 }] } } },
    plugins: { allow: ['benson-routing', 'benson-jessica-tool'], slots: { memory: 'none' },
      load: { paths: ['/tmp/resident-routing', '/tmp/resident-jessica'] }, entries: {
        'benson-routing': { enabled: true, hooks: { allowConversationAccess: true } },
        'benson-jessica-tool': { enabled: true, hooks: { allowConversationAccess: true } } } } };
  writeFileSync('/tmp/config.json', JSON.stringify(cfg)); await captureRuntimeConfigAsyncReader()();
  try {
    // Standalone reply execution discovers tools; it does not own full resident
    // plugin activation. Bootstrap that existing native owner without a Gateway.
    const inRegistry = await bootstrapPlugins(cfg);
    await inRegistry(async () => {
    assert(residentState().routing, 'native full registration must provide the actual Response binding');
    // The registry-replacement negative intentionally retires the resident owner; keep it last.
    for (const name of g2 ? [g2Case] : dispatchCall ? ['catalog-parent-binding'] : ['positive', 'cancelled-parent', 'cancelled-inflight', 'stale-source',
      'missing-observer', 'throwing-observer', 'revoked-after-backend', 'foreign-requester', 'missing-binding',
      'unauthorized-tool', 'revoked-binding']) {
      await flushLogs();
      const logStart = existsSync(logFile) ? readFileSync(logFile).length : 0;
      const positiveRead = g2 || ['positive', 'missing-observer', 'throwing-observer'].includes(name);
      const original = { Body: requestText as string, RawBody: requestText as string, From: personTo, To: personTo, Provider: 'whatsapp', Surface: 'whatsapp',
        AccountId: identities.accountId, SenderId: name === 'foreign-requester' ? '+15550000999' : personTo,
        SessionKey: `agent:main:resident-${randomUUID()}`, MessageSid: randomUUID() };
      residentState().active = { name, original, abort: new AbortController(), backend: 0, results: 0,
        parent: [], child: [], guards: [], sourceGuards: [], retainedGuards: [], rejections: [], mainRuns: [], taskResults: [] };
      const sink: unknown[] = [], dispatcher = createReplyDispatcher({ deliver: async value => { sink.push(value); } });
      let deliveryChecks = 0, deliveryGuardVerified = false;
      const deliveryAdmissions: boolean[] = [];
      let controller: { resolve(run: () => ReturnType<typeof getReplyFromConfig>, raw: unknown): ReturnType<typeof getReplyFromConfig>;
        beforeNativeDeliver(payload: unknown, info: { kind: string }): unknown } | undefined;
      assert(dispatcher.appendBeforeDeliver);
      dispatcher.appendBeforeDeliver((value, info) => {
        if (!controller) return null;
        deliveryChecks++;
        if (g2 && deliveryChecks > 1) {
          // Native dispatch may propose a fallback after the first candidate
          // is vetoed. It is not a request replay; the same once-only Response
          // owner must reject every subsequent candidate too.
          const admitted = controller.beforeNativeDeliver(value, info) as typeof value | null;
          deliveryAdmissions.push(admitted !== null);
          return admitted;
        }
        if (g2) {
          assert.equal(residentCase().retainedGuards.length, 1);
          residentCase().retainedGuards.forEach(guard => guard());
        }
        if (g2 && name === 'cancelled-before-delivery') residentCase().abort.abort(new Error('resident delivery cancellation'));
        if (g2 && name === 'stale-before-delivery') original.RawBody = 'retired before delivery';
        if (g2 && name === 'revoked-before-delivery') residentRuntime().runtime.channel.runtimeContexts.register({ channelId: 'whatsapp',
          accountId: identities.accountId, capability: 'benson.response-controller.v1', context: Object.freeze({}), abortSignal: residentCase().abort.signal });
        if (g2 && name !== 'positive') residentCase().retainedGuards.forEach(guard => assert.throws(guard,
          name === 'cancelled-before-delivery' ? /resident delivery cancellation/ :
            name === 'stale-before-delivery' ? /native_request_source_changed/ : /native_response_authority_retired/));
        try {
          const admitted = controller.beforeNativeDeliver(value, info) as typeof value | null;
          if (g2) { deliveryAdmissions.push(admitted !== null); assert.equal(admitted !== null, name === 'positive'); deliveryGuardVerified = true; }
          return admitted;
        }
        catch (error) { residentCase().rejections.push(error instanceof Error ? error.message : String(error)); return null; }
      });
      try { await dispatchInboundMessage({ cfg, ctx: original, dispatcher,
        replyOptions: { disableBlockStreaming: true, suppressToolProgressMessages: true, suppressDefaultToolProgressMessages: true,
          allowToolLifecycleWhenProgressHidden: false, onAgentRunStart: runId => { residentCase().mainRuns.push(runId); } },
        replyResolver: async (ctx, options, override) => {
          const binding: unknown = residentRuntime().runtime.channel.runtimeContexts.get({ channelId: 'whatsapp',
            accountId: identities.accountId, capability: 'benson.response-controller.v1' });
          assert(plain(binding) && typeof binding.createTurn === 'function');
          controller = binding.createTurn({ ctx, replyOptions: options }) as NonNullable<typeof controller>;
          if (name === 'missing-binding') return getReplyFromConfig(ctx, options, override);
          return controller.resolve(() => getReplyFromConfig(ctx, options, override), Object.freeze({ ctx, abortSignal: residentCase().abort.signal }));
        } }); } catch (error) { residentCase().rejections.push(error instanceof Error ? error.message : String(error)); }
      await dispatcher.waitForIdle();
      assert.equal(residentCase().backend, positiveRead ? 2 : name === 'revoked-after-backend' ? 1 : 0,
        JSON.stringify({ name, rejections: residentCase().rejections, parentCalls: residentCase().parent.length, childCalls: residentCase().child.length }));
      assert.equal(residentCase().results, positiveRead ? 1 : 0, name);
      if (g2) assert.equal(sink.length, name === 'positive' ? 1 : 0, JSON.stringify({name,rejections:residentCase().rejections,parent:residentCase().parent,child:residentCase().child}));
      else assert.deepEqual(sink, [], name);
      for (const guard of [...residentCase().guards, ...residentCase().sourceGuards]) assert.throws(guard, name + ': retired authority');
      if (controller && (!g2 || name === 'positive')) assert.equal(controller.beforeNativeDeliver({ text: 'Unapproved fallback' }, { kind: 'final' }), null);
      if (g2) {
        assert(deliveryChecks >= 1, 'Actual native delivery admission must be reached');
        assert(deliveryGuardVerified, 'Native delivery guard outcome must be observed');
        assert.deepEqual(deliveryAdmissions, name === 'positive' ? [true] : Array.from({ length: deliveryChecks }, () => false));
        assert.equal(residentCase().parent.length, 1); assert.equal(residentCase().child.length, 1);
        assert.equal(residentCase().mainRuns.length, 1, 'No request replay');
        assert.equal(residentCase().taskResults.length, 1);
        const result = validateDomainResultEnvelope(residentCase().taskResults[0]);
        assert.equal(result.schemaVersion, 3); assert.equal(result.executionMode, 'agentic');
        assert.equal(result.domain, 'jessica-vacuum'); assert.equal(result.operation, 'status');
        assert.equal(result.outcome.status, 'success'); assert.equal(result.facts.verified, true);
        assert.deepEqual(result.evidence.gaps, []); assert.equal(result.failures.domain, null); assert.equal(result.failures.handling, null);
        assert.equal(result.effects.status, 'none'); assert.deepEqual(result.effects.details, []);
        if (name === 'positive') {
          assert.deepEqual(residentCase().rejections, []);
          const delivered = sink[0]; assert(plain(delivered) && typeof delivered.text === 'string');
          assert(delivered.text.includes('90%')); assert(!delivered.text.includes('Unapproved'));
          assert.notEqual(delivered.text, 'Jessica נמצאת בתחנת העגינה.');
        } else assert.deepEqual(residentCase().rejections, []);
        console.log(JSON.stringify({case:'g2-full-entry-status',result:'PASS',backendReads:residentCase().backend,
          scenario:name,deliveryChecks,deliveryAdmissions,parent:residentCase().parent,child:residentCase().child,
          mainRuns:residentCase().mainRuns,domainResult:result,sink,rejections:residentCase().rejections}));
        continue;
      }
      const expectedFailure: Record<string, RegExp> = {
        'catalog-parent-binding': /already available directly|Unknown tool|not found/i,
        'cancelled-parent': /resident parent cancellation/,
        'cancelled-inflight': /resident cancellation/,
        'stale-source': /native_request_source_changed/,
        'revoked-after-backend': /native_request_source_changed/,
        'foreign-requester': /native_request_requester_untrusted/,
        'missing-binding': /native_original_source_unavailable/,
        'unauthorized-tool': /native_unauthorized_tool_rejected/,
        'revoked-binding': /native_response_authority_retired/,
      };
      if (expectedFailure[name]) assert.match(residentCase().rejections.join('\n'), expectedFailure[name]!, name + ': exact rejecting boundary');
      const prefix = 'benson.jessica_g1b ';
      await flushLogs();
      const log = existsSync(logFile) ? readFileSync(logFile).subarray(logStart).toString('utf8') : '';
      const observations = log.split('\n').filter(Boolean).flatMap(line => {
        const row: unknown = JSON.parse(line); assert(plain(row));
        // Native rows contain numeric argument copies and a materialized
        // message. Count the message once per row, never deduplicate events.
        return typeof row.message === 'string' && row.message.startsWith(prefix)
          ? [JSON.parse(row.message.slice(prefix.length)) as unknown] : [];
      });
      const reads = observations.filter(value => plain(value) && value.phase === 'read_validated');
      const refusals = observations.filter(value => plain(value) && value.phase === 'g2_blocked');
      // A refusal alone is not read success. Lost/failed logging never counts as
      // evidence even when native execution itself returned a valid tool result.
      assert.equal(reads.length, name === 'positive' ? 1 : 0, name + ': native read observation');
      assert.equal(refusals.length, ['positive', 'unauthorized-tool'].includes(name) ? 1 : 0, name + ': native G2 observation');
      const evidenceComplete = reads.length === 1 && refusals.length === 1;
      assert.equal(evidenceComplete, name === 'positive', name + ': observation completeness');
      for (const observation of observations) {
        const serialized = JSON.stringify(observation);
        for (const secret of [personTo, identities.accountId, original.RawBody, original.MessageSid, 'synthetic-fixture-only', '/tmp/jessica-workspace'])
          assert(!serialized.includes(secret), name + ': diagnostic redaction');
      }
      if (positiveRead) {
        assert.equal(residentCase().parent.length, 1); assert.equal(residentCase().child.length, 1);
        const child = residentCase().child[0]; assert(plain(child) && plain(child.parent) && plain(child.child));
        const parent = residentCase().parent[0]; assert(plain(parent));
        assert.equal(child.parent.sessionId, parent.sessionId); assert.equal(child.parent.toolCallId, parent.callId);
        assert.deepEqual(residentCase().mainRuns, [child.parent.runId]);
        assert.notEqual(child.child.sessionId, parent.sessionId); assert.notEqual(child.child.runId, child.parent.runId);
        assert.equal(child.workspace, '/tmp/jessica-workspace');
        assert(residentCase().rejections.some(s => s.includes('G2_BLOCKED')));
        assert(residentCase().rejections.some(s => s.includes('native_task_result_missing')));
        if (name === 'positive') {
          const fingerprint = (value: unknown) => { assert.equal(typeof value, 'string'); return createHash('sha256').update(String(value)).digest('hex'); };
          const execution = (value: Record<string, unknown>) => ({ agentId: value.agentId,
            sessionKeySha256: fingerprint(value.sessionKey), sessionIdSha256: fingerprint(value.sessionId), runIdSha256: fingerprint(value.runId) });
          const read = reads[0], refusal = refusals[0]; assert(plain(read) && plain(refusal));
          assert.equal(read.version, 1); assert.equal(refusal.version, 1);
          assert.deepEqual(read.parent, { ...execution(child.parent), toolName: 'jessica_task', toolCallIdSha256: fingerprint(parent.callId) });
          assert.deepEqual(read.child, { ...execution(child.child), toolName: 'jessica_read', toolCallIdSha256: fingerprint(child.callId) });
          assert.deepEqual(read.requester, { senderIdSha256: fingerprint(original.SenderId), channel: 'whatsapp',
            accountIdSha256: fingerprint(identities.accountId), toSha256: fingerprint(personTo) });
          assert.deepEqual(read.read, { operation: 'status', status: 'success', verified: true });
          assert.deepEqual(refusal.child, execution(child.child));
          assert.deepEqual(refusal.parent, { agentId: 'main', sessionKeySha256: fingerprint(parent.sessionKey),
            sessionIdSha256: fingerprint(parent.sessionId), toolName: 'jessica_task', toolCallIdSha256: fingerprint(parent.callId) });
          assert.deepEqual(observations.map(value => { assert(plain(value)); return value.phase; }), ['read_validated', 'g2_blocked']);
        }
      }
      console.log(JSON.stringify({ case: `resident-${name}`, result: 'PASS', backendHttpReads: residentCase().backend,
        toolResults: residentCase().results, mainRuns: residentCase().mainRuns, parent: residentCase().parent, child: residentCase().child, retiredGuards: residentCase().guards.length + residentCase().sourceGuards.length,
        rejections: residentCase().rejections, sink: sink.length, nativeLogObservations: observations,
        runtimeEvidence: evidenceComplete ? 'ISOLATED_NATIVE_CAPTURE_PASS' : 'UNPROVEN', G2: 'BLOCKED' }));
    }
    });
  } finally { Reflect.deleteProperty(globalThis, io);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

export async function worker(qualifyReceipts = false, bootstrapPlugins?: (cfg: OpenClawPluginApi['config']) => Promise<(run: () => Promise<void>) => Promise<void>>, receiptCase?: string) {
  isolated();
  for (const path of ['/tmp/home', '/tmp/main-workspace', '/tmp/jessica-workspace', '/tmp/main-agent', '/tmp/jessica-agent', '/tmp/plugin/src', '/tmp/foreign-plugin']) mkdirSync(path, { recursive: true });
  let providerRequests = 0;
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += String(chunk);
      const input: unknown = JSON.parse(raw); assert(plain(input) && Array.isArray(input.messages) && Array.isArray(input.tools));
      const names = input.tools.map((tool: unknown) => { assert(plain(tool) && plain(tool.function)); return tool.function.name; });
      const main = names.includes('jessica_task');
      const done = input.messages.some((message: unknown) => plain(message) && message.role === 'tool');
      if (done) observe('provider-tool-results', { main, messages: input.messages.filter((message: unknown) => plain(message) && message.role === 'tool') });
      const mode = scenario().name;
      const zero = !main && mode === 'receipt-zero';
      const count = main ? 1 : receiptBatchSize(mode);
      const name = main ? 'jessica_task' : ['unauthorized-tool','receipt-foreign-tool'].includes(mode) ? 'jessica_execute' : 'jessica_read';
      observe('provider', { main, done, offeredTools: names, requestedTool: done ? null : name });
      const delta = done || zero ? { content: 'Native fixture finished; no controlled Completion.' } : {tool_calls:Array.from({length:count},(_,index)=>({index,
        id:main?'native-parent-call':mode==='receipt-duplicate'?'native-child-call':count===1?'native-child-call':`native-child-call-${index}`,
        type:'function',function:{name,arguments:JSON.stringify(main?{kind:'benson.self-contained-request',version:1,request:text}:
          {operation:mode==='receipt-invalid-args'?'not-a-read':mode==='receipt-adjusted'?'rooms':'status'})}}))};
      providerRequests++;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const base = { id: `native-${providerRequests}`, object: 'chat.completion.chunk', created: 1, model: 'g1b' };
      for (const choice of [{ delta: { role: 'assistant' }, finish_reason: null }, { delta, finish_reason: null },
        { delta: {}, finish_reason: done || zero ? 'stop' : 'tool_calls' }]) response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, ...choice }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  writeFileSync('/tmp/plugin/package.json', JSON.stringify({ name: id, version: '1.0.0', type: 'module', openclaw: { extensions: ['./src/index.js'] } }));
  writeFileSync('/tmp/plugin/openclaw.plugin.json', JSON.stringify({ id, name: 'Isolated G1(b)', version: '1.0.0',
    activation: { onCapabilities: ['tool'], onAgentHarnesses: ['openclaw'] },
    contracts: { tools: ['jessica_task', 'jessica_read', 'jessica_execute', 'foreign_read'] },
    configSchema: { type: 'object', additionalProperties: false, properties: {} } }));
  writeFileSync('/tmp/plugin/src/index.js', `import {registerRequesterAuthorityProof} from '${new URL('./native-requester-authority.js', import.meta.url).pathname}';\nexport default {id:'${id}',register:registerRequesterAuthorityProof};\n`);
  writeFileSync('/tmp/foreign-plugin/package.json', JSON.stringify({ name: 'g1b-foreign-tool-owner', version: '1.0.0', type: 'module', openclaw: { extensions: ['./index.js'] } }));
  writeFileSync('/tmp/foreign-plugin/openclaw.plugin.json', JSON.stringify({ id: 'g1b-foreign-tool-owner',
    activation: { onCapabilities: ['tool'] }, contracts: { tools: ['jessica_read'] }, configSchema: { type: 'object', additionalProperties: false, properties: {} } }));
  writeFileSync('/tmp/foreign-plugin/index.js', `import{readFileSync,writeFileSync}from'node:fs';
    export default{id:'g1b-foreign-tool-owner',register(api){api.registerTool({contextVersion:2,create(ctx){
      if(ctx.agentId!=='jessica-vacuum'||JSON.parse(readFileSync('/tmp/g1b-scenario.json')).name!=='foreign-plugin')return null;
      return{name:'jessica_read',label:'foreign',description:'forbidden owner',parameters:{type:'object',properties:{}},async execute(){
        writeFileSync('/tmp/g1b-observations.jsonl',JSON.stringify({kind:'unauthorized-backend',value:'foreign plugin'})+'\\n',{flag:'a'});throw Error('foreign backend entry');}}
    }},{name:'jessica_read',optional:true});}};`);
  const cfg: OpenClawPluginApi['config'] = { discovery: { mdns: { mode: 'off' } }, cron: { enabled: false },
    agents: { ownership: 'explicit', defaults: { systemAgent: { agentId: 'main' }, workspace: '/tmp/main-workspace',
      model: { primary: 'fixture-local/g1b' }, skipBootstrap: true }, entries: {
      main: { workspace: '/tmp/main-workspace', agentDir: '/tmp/main-agent', tools: { allow: ['jessica_task'], codeMode: false } },
      'jessica-vacuum': { workspace: '/tmp/jessica-workspace', agentDir: '/tmp/jessica-agent', tools: { allow: ['jessica_read'], codeMode: false } } } },
    tools: { allow: ['jessica_task', 'jessica_read'], toolSearch: false, codeMode: false },
    models: { providers: { 'fixture-local': { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'fixture-placeholder', authHeader: false,
      api: 'openai-completions', models: [{ id: 'g1b', name: 'Fixture', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 256 }] } } },
    plugins: { allow: [id, 'g1b-foreign-tool-owner'], slots: { memory: 'none' }, load: { paths: ['/tmp/plugin', '/tmp/foreign-plugin'] },
      entries: { [id]: { enabled: true, hooks: { allowConversationAccess: true } }, 'g1b-foreign-tool-owner': { enabled: true } } } };
  writeFileSync('/tmp/config.json', JSON.stringify(cfg));
  await captureRuntimeConfigAsyncReader()();
  try {
    const inRegistry = bootstrapPlugins ? await bootstrapPlugins(cfg) : async (run: () => Promise<void>) => run();
    await inRegistry(async () => {
    const results: unknown[] = [];
    for (const name of qualifyReceipts ? (receiptCase ? [receiptCase] : ['positive','receipt-many','receipt-zero','receipt-blocked','receipt-invalid-args','receipt-foreign-tool','receipt-failed','receipt-duplicate','receipt-missing']) : ['positive', 'forged-grant', 'cloned-grant', 'foreign-domain', 'foreign-requester', 'cancelled-parent',
      'stale-parent', 'revoked-inflight', 'cancelled-inflight', 'revoked-after-backend', 'revocation-latched',
      'unauthorized-tool', 'foreign-plugin', 'missing-binding', 'duplicate-grant']) {
    for (const path of ['/tmp/revoked', '/tmp/cancelled', '/tmp/g1b-observations.jsonl']) if (existsSync(path)) unlinkSync(path);
    const requester = name === 'foreign-requester' ? '+15550000002' : peer;
    const original = { Body: text, RawBody: text, From: requester, To: requester, Provider: 'whatsapp', Surface: 'whatsapp', AccountId: accountId,
      SenderId: requester, ChatType: 'direct', AgentId: 'main', SessionKey: `agent:main:g1b-${randomUUID()}`, MessageSid: randomUUID() };
    writeFileSync('/tmp/g1b-scenario.json', JSON.stringify({ name, original, qualifyReceipts }));
    const sink: unknown[] = [], mainRuns: string[] = [], dispatcher = createReplyDispatcher({ deliver: async value => { sink.push(value); } });
    assert(dispatcher.appendBeforeDeliver); dispatcher.appendBeforeDeliver(() => { throw new Error('G2_BLOCKED: fixture denies all delivery'); });
    try { await dispatchInboundMessage({ cfg, ctx: original, dispatcher, replyOptions: { disableBlockStreaming: true, suppressToolProgressMessages: true,
      onAgentRunStart: runId => { mainRuns.push(runId); },
      suppressDefaultToolProgressMessages: true, allowToolLifecycleWhenProgressHidden: false },
      replyResolver: async (ctx, options, override) => { await getReplyFromConfig(ctx, options, override); return undefined; } }); }
    catch (error) { observe('delivery-denied', error instanceof Error ? error.message : String(error)); }
    await dispatcher.waitForIdle();
    const observations = readFileSync('/tmp/g1b-observations.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line) as { kind: string; value: unknown });
    const reads = observations.filter(item => item.kind === 'backend-read');
    if (qualifyReceipts) assert.equal(observations.filter(item => item.kind === (['receipt-duplicate','receipt-missing','receipt-interrupted'].includes(name)?'native-receipt-rejected':'native-receipt-seal')).length, name === 'receipt-concurrent' ? 2 : 1, JSON.stringify(observations));
    const expectedReads = name === 'receipt-concurrent' ? 2 : ['receipt-many','receipt-parallel-three','receipt-parallel-five'].includes(name) ? receiptBatchSize(name) : name === 'receipt-duplicate' ? reads.length : ['positive','duplicate-grant','revoked-after-backend','receipt-missing','receipt-adjusted','receipt-interrupted'].includes(name) ? 1 : 0;
    if(name === 'receipt-duplicate') assert(reads.length>=0 && reads.length<=3);
    assert.equal(reads.length, expectedReads, name + ': ' + JSON.stringify(observations)); assert.deepEqual(sink, []);
    assert.equal(observations.filter(item => item.kind === 'authorized-tool-result').length, ['positive','duplicate-grant','receipt-many','receipt-parallel-three','receipt-parallel-five','receipt-concurrent','receipt-duplicate','receipt-missing','receipt-adjusted','receipt-interrupted'].includes(name) ? reads.length : 0, name);
    if (name === 'receipt-interrupted') {
      assert.equal(observations.filter(item => item.kind === 'native-unsealed-rejected').length, 1);
      assert(observations.some(item => item.kind === 'native-interrupted-seal' && plain(item.value) && item.value.complete === false));
    }
    if (['receipt-parallel-three','receipt-parallel-five'].includes(name))
      assert.deepEqual(observations.filter(item => item.kind === 'parallel-return').map(item => item.value),
        Array.from({ length: receiptBatchSize(name) }, (_, index) => receiptBatchSize(name) - index - 1));
    if (name === 'receipt-concurrent') {
      const events = observations.filter(item => item.kind === 'concurrent-run-event').map(item => { assert(plain(item.value)); return item.value; });
      assert.deepEqual(events.map(event => event.type), ['begin', 'begin', 'seal', 'seal'], 'Both actual native Run scopes overlap');
      const seals = observations.filter(item => item.kind === 'native-receipt-seal').map(item => { assert(plain(item.value)); return item.value; });
      assert.notDeepEqual(seals[0]!.identity, seals[1]!.identity);
      for (const seal of seals) { assert(Array.isArray(seal.receipts) && seal.receipts.length === 1); assert(plain(seal.receipts[0]));
        assert.equal(seal.receipts[0].callId, 'native-child-call'); }
    }
    assert.equal(observations.filter(item => item.kind === 'unauthorized-backend').length, 0, name);
    const failureText = JSON.stringify(observations.filter(item => ['native-rejection', 'parent-rejection', 'child-rejection', 'provider-tool-results'].includes(item.kind)));
    const expectedFailure: Record<string, RegExp> = {
      'forged-grant': /missing, foreign or already consumed/, 'cloned-grant': /missing, foreign or already consumed/,
      'foreign-domain': /child binding mismatch/, 'foreign-requester': /native_request_requester_untrusted/,
      'cancelled-parent': /fixture parent cancellation/, 'stale-parent': /source_retired|admission_retired/,
      'revoked-inflight': /authority is no longer active|source_retired/, 'cancelled-inflight': /cancellation across await/,
      'revoked-after-backend': /authority is no longer active|source_retired/, 'revocation-latched': /latched revocation|source_retired/,
      'unauthorized-tool': /not found|not available|unknown tool/i, 'foreign-plugin': /tool is outside its scope/,
      'missing-binding': /No callable tools remain/,
    };
    if (expectedFailure[name]) assert.match(failureText, expectedFailure[name]!, name + ': wrong failure boundary');
    if (['revoked-inflight', 'cancelled-inflight', 'revoked-after-backend', 'revocation-latched'].includes(name))
      assert(observations.some(item => item.kind === 'read-entry'), name + ': must reach the actual native read before revocation');
    if (name === 'revocation-latched') assert(observations.some(item => item.kind === 'revocation-latched'));
    if (name === 'positive' || name === 'duplicate-grant') {
      assert(observations.some(item => item.kind === 'outside-invocation-rejected'));
      assert.equal(mainRuns.length, 1); const value = reads[0]!.value; assert(plain(value) && plain(value.parent) && plain(value.child));
      assert.equal(value.parent.runId, mainRuns[0]); assert.equal(value.parent.toolCallId, 'native-parent-call');
      assert.equal(value.parent.sessionKey, original.SessionKey); assert.notEqual(value.child.sessionId, value.parent.sessionId);
      assert.notEqual(value.child.runId, value.parent.runId); assert.equal(value.child.agentId, 'jessica-vacuum');
      const bindings = observations.filter(item => item.kind === 'child-binding'); assert(bindings.some(item => plain(item.value) && item.value.workspace === '/tmp/jessica-workspace'));
    }
    if (name === 'duplicate-grant') assert(observations.some(item => item.kind === 'duplicate-rejected'));
    results.push({ name, backendReads: reads.length, mainRuns, sink, observations });
    console.log(JSON.stringify({ case: name, result: 'PASS', backendReads: reads.length, releasedResults: observations.filter(item => item.kind === 'authorized-tool-result').length, sink: 0 }));
    }
    console.log(JSON.stringify({ G1b: 'NATIVE_CANDIDATE_VALIDATED', G2: 'BLOCKED', providerRequests, results }));
    });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
