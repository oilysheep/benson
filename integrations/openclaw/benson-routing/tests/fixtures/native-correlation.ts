import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { createReplyDispatcher, dispatchInboundMessage, settleReplyDispatcher } from 'openclaw/plugin-sdk/reply-runtime';
import { validateResult } from '../../../../../agents/jessica-vacuum/lib/results.js';
import { executeJessicaStatusTask } from '../../../../../agents/jessica-vacuum/lib/task.js';
import { loadPolicy, authorize } from '../../../../../agents/jessica-vacuum/lib/policy.js';
import { createJessicaTaskToolFactory } from '../../../plugins/benson-jessica-tool/src/tool.js';
import { createCompletionAuthority, acceptAgentCompletion, validateCompletion } from '../../core/completion.js';
import type { Binding6, Completion6 } from '../../core/completion-contracts.js';
import { validateDomainResult, createCompletionDomainResult } from '../../core/domain-result.js';
import { createResponseV3Envelope } from '../../core/legacy-response.js';
import { createMainResponseDelivery } from '../../core/response-control.js';
import { renderJessicaDomainResult } from '../../../../../agents/jessica-vacuum/lib/presentation.js';

const report = '/tmp/correlation-result.json';
const pluginId = 'benson-jessica-tool';
type Observation = { runId: string; callId: string; sessionId: string; sessionKey: string; requesterPresent: boolean };
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function writeReport(value: unknown) {
  writeFileSync(`${report}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${report}.tmp`, report);
}
export function isolated() {
  assert.equal(process.env.BENSON_NATIVE_CORRELATION_ISOLATED, '1');
  assert.equal(existsSync('/home/oa'), false);
  assert(readFileSync('/proc/self/mountinfo', 'utf8').split('\n').some(line =>
    line.includes(' /repo/node_modules/openclaw ') && line.includes(' - overlay ')), 'SDK writes must stay in ephemeral overlay');
  assert.deepEqual(readFileSync('/proc/net/dev', 'utf8').trim().split('\n').slice(2).map(line => line.split(':')[0]?.trim()), ['lo']);
  assert.equal(readFileSync('/proc/net/route', 'utf8').trim().split('\n').length, 1);
}

function completionFacts(value: ReturnType<typeof validateDomainResult>): Completion6['facts'] {
  assert(value.domain === 'jessica-vacuum' || value.domain === 'reminder');
  return { domain: value.domain, domainSchemaVersion: value.domainSchemaVersion, operation: value.operation,
    status: value.outcome.status, verified: value.facts.verified, verificationScope: value.facts.verificationScope,
    data: value.facts.data, warnings: value.warnings, error: value.failures.domain, pendingContext: value.pendingContext,
    effects: value.effects.details, uncertainty: value.uncertainty };
}

/** Adapter composition only. This disposable variant is never production registration. */
function registerCompletionV6Proof(api: OpenClawPluginApi) {
  const cancellation = process.env.BENSON_NATIVE_COMPLETION_V6_ONLY === 'cancel';
  const parentAbort = new AbortController(), readSettled = Promise.withResolvers<void>();
  let cancellationRejected = false;
  const policy = loadPolicy({ version: '1', defaultDecision: 'deny', rules: ['read', 'control'].map(actionClass => ({ subject: 'reader', actionClass,
    deviceScope: 'jessica-vacuum', decision: 'allow' })) });
  type Source = Parameters<Parameters<typeof createJessicaTaskToolFactory>[0]['read']>;
  type Hook = Observation & { tool: string };
  type Value = ReturnType<typeof validateDomainResult>;
  const hooks: Hook[] = [], returned: (Hook & { value: Value })[] = [];
  const after: { runId: string | undefined; callId: string | undefined; value: unknown; error: string | undefined }[] = [];
  const terminals: { runId: string | undefined; sessionKey: string | undefined; sessionId: string | undefined;
    success: boolean; messages: unknown[] }[] = [];
  const retainedChildGuards: (() => void)[] = [];
  const childSessionKey = `agent:jessica-vacuum:subagent:v6-${randomUUID()}`;
  const parentSessionKey = `agent:main:v6-${randomUUID()}`, requestId = randomUUID();
  let source: { identity: Source[1]; authority: Source[2]; parent: Hook } | undefined;
  let accepted: Value | undefined, retainedRecord: Completion6 | undefined;
  let retainedAuthority: ReturnType<typeof createCompletionAuthority> | undefined;
  let backendReads = 0, consumed = false, negativeEvidenceCases = 0;
  api.on('before_tool_call', (event, ctx) => {
    assert(['jessica_task', 'jessica_read'].includes(event.toolName));
    assert(ctx.runId && ctx.toolCallId && ctx.sessionId && ctx.sessionKey);
    assert.equal(event.runId, ctx.runId); assert.equal(event.toolCallId, ctx.toolCallId);
    hooks.push({ tool: event.toolName, runId: ctx.runId, callId: ctx.toolCallId, sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey, requesterPresent: ctx.requester !== undefined });
  });
  api.on('after_tool_call', (event, ctx) => {
    if (event.toolName === 'jessica_read') after.push({ runId: ctx.runId, callId: ctx.toolCallId, value: event.result, error: event.error });
  });
  api.on('agent_end', (event, ctx) => {
    if (ctx.sessionKey === childSessionKey) terminals.push({ runId: ctx.runId, sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId, success: event.success, messages: event.messages });
  });
  api.registerTool({ contextVersion: 2, create(ctx) {
    if (ctx.agentId !== 'jessica-vacuum') return null;
    return { name: 'jessica_read', label: 'Isolated controlled Domain read', description: 'Read the disposable domain through its existing owner.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute(callId, params, signal) {
        assert.deepEqual(params, {}); assert(source); const original = source;
        const assertCurrent = () => {
          original.authority.signal.throwIfAborted(); original.authority.assertCurrent();
          signal?.throwIfAborted(); ctx.assertInvocationCurrent(); authorize(policy, original.identity, 'read');
          assert.equal(source, original); assert.equal(ctx.sessionKey, childSessionKey);
        };
        assertCurrent(); retainedChildGuards.push(assertCurrent);
        const matched = hooks.filter(item => item.tool === 'jessica_read' && item.callId === callId && item.sessionId === ctx.sessionId);
        assert.equal(matched.length, 1); const binding = matched[0]; assert(binding);
        const value = await executeJessicaStatusTask(callId, { operation: 'status' }, { identity: original.identity,
          authority: { signal: AbortSignal.any([original.authority.signal, ...(signal ? [signal] : [])]), assertCurrent },
          async read(_request, _identity, authority) {
            if (cancellation) {
              authority.assertCurrent();
              // A causal barrier, not a timing guess: cancel the real native
              // parent while its child read is suspended, then revalidate.
              await Promise.resolve().then(() => parentAbort.abort(new Error('Isolated parent cancellation')));
              try { authority.assertCurrent(); } catch (error) { cancellationRejected = true; throw error; }
              throw new Error('Cancelled source unexpectedly remained current');
            }
            authority.assertCurrent(); backendReads++; const at = new Date().toISOString();
            return validateResult({ schemaVersion: '1', domain: 'jessica-vacuum', operation: 'status', status: 'success', verified: true,
              data: { kind: 'status', observedAt: at, sourceUpdatedAt: at, freshness: 'fresh', state: 'docked', batteryLevel: 100,
                activeSegments: [], currentSegment: null }, warnings: [], error: null, pendingContext: null }, null, new Date(at));
          } });
        assertCurrent(); returned.push({ ...binding, value });
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
      } };
  } });
  const create = createJessicaTaskToolFactory({ roster: { accountId: 'fixture-account', approvedIds: ['reader'],
    subjectForRoute: route => route === 'fixture-private' ? 'reader' : null }, policy,
    async read(request, identity, authority) {
      authority.assertCurrent(); const parents = hooks.filter(item => item.tool === 'jessica_task' && item.sessionKey === parentSessionKey);
      assert.equal(parents.length, 1); const parent = parents[0]; assert(parent);
      source = { identity, authority, parent }; const original = source;
      try {
      const receipt = await api.runtime.subagent.run({ sessionKey: childSessionKey, message: 'G3_COMPLETION_CHILD: call jessica_read once with {} and return the completion.',
        toolsAlsoAllow: ['jessica_read'], promptMode: 'minimal', deliver: false,
        assertCurrent() { authority.signal.throwIfAborted(); authority.assertCurrent(); } });
      const terminal = await api.runtime.subagent.waitForRun({ runId: receipt.runId, timeoutMs: 45_000 });
      if (cancellation) { authority.assertCurrent(); throw new Error('Cancelled source unexpectedly accepted child completion'); }
      assert.equal(terminal.status, 'ok'); assert.equal(receipt.sessionKey, childSessionKey);
      assert.equal(terminals.length, 1); const ended = terminals[0]; assert(ended);
      assert.equal(returned.length, 1); const child = returned[0]; assert(child);
      const binding: Binding6 = { inputId: requestId, admissionId: parent.callId, conversationId: parentSessionKey,
        runId: receipt.runId, agentId: 'jessica-vacuum', sessionKey: childSessionKey, sessionId: child.sessionId,
        domain: 'jessica-vacuum', taskId: parent.callId, caller: { runId: parent.runId, agentId: 'main',
          sessionKey: parent.sessionKey, sessionId: parent.sessionId }, completionTarget: 'CALLER', authorizationId: parent.callId,
        parentContinuation: { eligible: true, reason: null }, deliveryPolicy: { eligible: false, reason: null } };
      // This view permits deterministic evidence fault injection, never authorization.
      let view = { runId: ended.runId, success: ended.success, messages: ended.messages };
      const assertEvidence = (candidate: Readonly<Binding6>) => {
        authority.signal.throwIfAborted(); authority.assertCurrent(); authorize(policy, identity, 'read');
        assert.equal(source, original); assert(!consumed, 'Completion already consumed');
        assert.equal(JSON.stringify(candidate), JSON.stringify(binding));
        assert.equal(view.runId, receipt.runId); assert.equal(child.runId, receipt.runId);
        assert.equal(ended.sessionId, child.sessionId); assert.equal(ended.sessionKey, childSessionKey); assert(view.success);
        const entries = view.messages.filter(record);
        const calls = entries.flatMap(entry => entry.role === 'assistant' && Array.isArray(entry.content)
          ? entry.content.filter((part: unknown) => record(part) && part.type === 'toolCall') : []);
        const values = entries.filter(entry => entry.role === 'toolResult');
        assert.equal(calls.length, 1); assert.equal(values.length, 1);
        const call: unknown = calls[0], value = values[0]; assert(record(call) && value);
        assert.equal(call.id, child.callId); assert.equal(call.name, 'jessica_read');
        assert.equal(value.toolCallId, child.callId); assert.equal(value.toolName, 'jessica_read'); assert(!value.isError);
        assert(Array.isArray(value.content)); assert.equal(value.content.length, 1); const content: unknown = value.content[0]; assert(record(content));
        assert.equal(content.type, 'text'); assert.equal(content.text, JSON.stringify(child.value));
        assert.equal(hooks.filter(item => item.tool === 'jessica_read').length, 1);
        assert.equal(after.length, 1); const completed = after[0]; assert(completed && !completed.error);
        assert.equal(completed.runId, child.runId); assert.equal(completed.callId, child.callId);
        assert(record(completed.value)); assert.equal(JSON.stringify(completed.value.details), JSON.stringify(child.value));
      };
      assertEvidence(binding);
      for (const bad of [{ ...view, runId: 'foreign-run' }, { ...view, success: false }, { ...view, messages: [] },
        { ...view, messages: [...view.messages, ...view.messages.filter(item => record(item) && item.role === 'toolResult')] }]) {
        const previous = view; view = bad; assert.throws(() => assertEvidence(binding)); view = previous; negativeEvidenceCases++;
      }
      // Retired child invocation is expected; current source/domain plus controlled
      // completed evidence authorize consumption, never a fictional active child.
      assert.equal(retainedChildGuards.length, 1); assert.throws(retainedChildGuards[0]!);
      const facts = completionFacts(child.value);
      const completionAuthority = createCompletionAuthority({ schemaVersion: 6, kind: 'domain-task', binding, knownFacts: facts,
        results: [], coverage: 'complete', gaps: [], origin: 'agent' }, { assertCurrent: assertEvidence });
      const final = ended.messages.findLast(item => record(item) && item.role === 'assistant'); assert(record(final) && Array.isArray(final.content));
      const parts = final.content.filter((part: unknown) => record(part) && part.type === 'text'); assert.equal(parts.length, 1);
      const part: unknown = parts[0]; assert(record(part) && typeof part.text === 'string');
      const completion = acceptAgentCompletion(JSON.parse(part.text), completionAuthority); assert.equal(completion.schemaVersion, 6);
      assert.throws(() => validateCompletion({ ...completion, binding: { ...binding, runId: 'foreign-run' } }, completionAuthority));
      const value = createCompletionDomainResult(completion, completionAuthority, { expectedRunId: receipt.runId });
      assert.equal(value.executionMode, 'agentic'); assert.equal(value.effects.status, 'none');
      assert.deepEqual(value.facts, child.value.facts); assert.deepEqual(value.content, child.value.content);
      accepted = value; retainedRecord = completion; retainedAuthority = completionAuthority;
      // The deterministic outer read carrier remains a read carrier. The fixture
      // serializer below emits the separately controlled child result explicitly.
      assert(record(facts.data));
      return validateResult({ schemaVersion: facts.domainSchemaVersion, domain: facts.domain, operation: facts.operation, status: facts.status,
        verified: facts.verified, data: facts.data, warnings: facts.warnings, error: facts.error, pendingContext: facts.pendingContext }, null, new Date());
      } catch (error) {
        if (!cancellation) writeReport({ completion: 'BLOCKED', stage: 'source-read', backendReads, hooks, after, terminals,
          error: error instanceof Error ? error.message : 'Source read failed' });
        throw error;
      } finally { readSettled.resolve(); }
    }, jsonResult(outer) {
      assert(accepted && retainedRecord && retainedAuthority); assert.deepEqual(outer.facts, accepted.facts);
      validateCompletion(retainedRecord, retainedAuthority); consumed = true;
      assert.throws(() => validateCompletion(retainedRecord, retainedAuthority), /already consumed/);
      return { content: [{ type: 'text', text: JSON.stringify(accepted) }], details: accepted };
    } });
  api.registerTool({ contextVersion: 2, create(ctx) {
    const tool = create(ctx); if (!tool || Array.isArray(tool)) return tool;
    return { ...tool, description: 'Isolated adapter composition: authorize a read, await a controlled Domain Run, and return its validated DomainResult.' };
  } });
  api.on('gateway_start', async () => {
    try {
      const runIds: string[] = [], outcomes: string[] = [], sink: unknown[] = [], errors: string[] = [];
      const delivery = createMainResponseDelivery({ requestId, agentId: 'main', runId() { assert.equal(runIds.length, 1); return runIds[0]!; },
        assertCurrent() { parentAbort.signal.throwIfAborted(); assert.deepEqual(outcomes, ['completed']); }, responseFor: () => {
          assert(accepted); return createResponseV3Envelope({ messageCandidate: null }, { requestId,
            source: { type: 'main', agentId: 'main', runId: runIds[0] }, results: [accepted],
            responsePolicy: { preferredMode: 'deterministic', allowedModes: ['deterministic'] }, lifecycle: { domainExecution: 'attempted', failure: null } });
        }, presentation: { language: 'he', get now() { return new Date().toISOString(); }, timezone: 'Asia/Jerusalem',
          assertResponseCurrent(response) { assert(accepted); assert.equal(response.requestId, requestId);
            assert.deepEqual(response.results, [accepted]); assert.equal(response.source.type, 'main');
            assert(response.source.type === 'main'); assert.equal(response.source.runId, runIds[0]); }, renderDomainResult: renderJessicaDomainResult },
        deliver: async payload => { sink.push(payload); } });
      const dispatcher = createReplyDispatcher({ deliver: (payload, info) => delivery.deliver(payload, info), onError: error => { errors.push(String(error)); } });
      try { await dispatchInboundMessage({ cfg: api.config, dispatcher, ctx: { Body: 'G3_MAIN_READ_V6', From: 'fixture-private', To: 'fixture-private',
        SenderId: 'fixture-private', AccountId: 'fixture-account', AgentId: 'main', SessionKey: parentSessionKey, Provider: 'whatsapp', Surface: 'whatsapp',
        ChatType: 'direct', MessageSid: requestId, CommandAuthorized: true }, replyOptions: { disableTools: false, disableBlockStreaming: true, abortSignal: parentAbort.signal,
          onAgentRunStart: runId => runIds.push(runId), onAgentRunTerminalOutcome: outcome => outcomes.push(outcome) } });
      } catch (error) { if (!cancellation || !parentAbort.signal.aborted) throw error;
      } finally { await settleReplyDispatcher({ dispatcher }); }
      await readSettled.promise;
      if (cancellation) {
        assert(source); assert(parentAbort.signal.aborted); assert(cancellationRejected);
        assert.equal(backendReads, 0); assert.equal(returned.length, 0); assert.equal(accepted, undefined);
        assert.equal(retainedAuthority, undefined); assert.deepEqual(sink, []);
        assert.throws(() => source!.authority.assertCurrent());
        writeReport({ completion: 'PASS', G3: 'BLOCKED', mode: 'cancel', backendReads, sink, producedCompletions: 0,
          cancellationRejectedAcrossAwait: true, outcomes,
          limits: 'Actual native parent abort prevents the child domain read and controlled Completion; does not prove the native child stops, universal terminal replies, restart recovery or production authority.' }); return;
      }
      assert(accepted && source && retainedRecord && retainedAuthority); assert.deepEqual(errors, []);
      assert.equal(backendReads, 1); assert.equal(sink.length, 1); assert.equal(delivery.snapshot().outcome, 'delivered');
      assert.throws(() => source!.authority.assertCurrent()); assert.throws(() => validateCompletion(retainedRecord, retainedAuthority));
      await assert.rejects(api.runtime.subagent.run({ sessionKey: `agent:jessica-vacuum:subagent:retired-${randomUUID()}`,
        message: 'Must not reach a model or tool.', deliver: false, assertCurrent: () => source!.authority.assertCurrent() }));
      assert.equal(backendReads, 1); assert.equal(hooks.length, 2);
      writeReport({ completion: 'PASS', G3: 'BLOCKED', schemaVersion: 6, backendReads, nativeRuns: 2, sink,
        binding: retainedRecord.binding, result: accepted, delivery: delivery.snapshot(), negativeEvidenceCases,
        retiredAdmissionRejected: true, duplicateRejected: true, retiredChildInvocationRejected: true,
        limits: 'Isolated adapter composition with real original Main SourceAdmission and child native guards; disposable identity/policy/backend/response authority. No production bridge, native permission revocation proof, child cancellation guarantee, restart custody, Main delivery authority or universal terminal coverage.' });
    } catch (error) { writeReport({ completion: 'BLOCKED', backendReads, hooks, after, terminals,
      error: error instanceof Error ? error.message : 'Completion fixture failed' }); }
  }, { timeoutMs: 100_000 });
}

/** Disposable variant of the existing plugin owner; never installed or loaded in production. */
export default {
  id: pluginId,
  register(api: OpenClawPluginApi) {
    isolated();
    if (process.env.BENSON_NATIVE_COMPLETION_V6_ONLY) { registerCompletionV6Proof(api); return; }
    const hooks: Observation[] = [];
    const results: (Observation & { result: ReturnType<typeof validateResult> })[] = [];
    api.on('before_tool_call', (event, ctx) => {
      if (event.toolName !== 'jessica_read') throw new Error('Unexpected fixture tool');
      assert.equal(typeof ctx.runId, 'string'); assert.equal(typeof ctx.toolCallId, 'string');
      assert.equal(typeof ctx.sessionId, 'string'); assert.equal(typeof ctx.sessionKey, 'string');
      assert.equal(event.runId, ctx.runId); assert.equal(event.toolCallId, ctx.toolCallId);
      if (!ctx.runId || !ctx.toolCallId || !ctx.sessionId || !ctx.sessionKey) throw new Error('Missing host correlation');
      hooks.push({ runId: ctx.runId, callId: ctx.toolCallId, sessionId: ctx.sessionId, sessionKey: ctx.sessionKey,
        requesterPresent: ctx.requester !== undefined });
    });
    api.registerTool({ contextVersion: 2, create(ctx) {
      return { name: 'jessica_read', label: 'Jessica isolated fixture read', description: 'Read the disposable fixture status once.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        async execute(callId, params) {
          ctx.assertInvocationCurrent();
          assert.equal(ctx.agentId, 'jessica-vacuum'); assert.deepEqual(params, {});
          const matches = hooks.filter(item => item.callId === callId && item.sessionId === ctx.sessionId);
          assert.equal(matches.length, 1, 'Missing or ambiguous host-to-handler mapping');
          const binding = matches[0]; assert(binding);
          assert.equal(binding.sessionKey, ctx.sessionKey);
          const at = new Date().toISOString();
          // Synthetic read observation, validated by the existing domain owner.
          // No HA transport, requester grant or physical/business success is inferred.
          const result = validateResult({ schemaVersion: '1', domain: 'jessica-vacuum', operation: 'status', status: 'success', verified: true,
            data: { kind: 'status', observedAt: at, sourceUpdatedAt: at, freshness: 'fresh', state: 'docked', batteryLevel: 100,
              activeSegments: [], currentSegment: null }, warnings: [], error: null, pendingContext: null }, null, new Date(at));
          ctx.assertInvocationCurrent();
          results.push({ ...binding, result });
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
        } };
    } }, { optional: true });
    api.on('gateway_start', async () => {
      try {
        // A fixture/system launch is not original user/delegated authority.
        const receipts = await Promise.all(['a', 'b'].map(id => api.runtime.subagent.run({
          sessionKey: `agent:jessica-vacuum:subagent:correlation-${id}`, message: 'Call jessica_read once with {} and then finish.',
          toolsAlsoAllow: ['jessica_read'], promptMode: 'minimal', deliver: false,
        })));
        const terminals = await Promise.all(receipts.map(receipt => api.runtime.subagent.waitForRun({ runId: receipt.runId, timeoutMs: 45_000 })));
        assert.equal(new Set(receipts.map(item => item.runId)).size, 2);
        const consumed = new Set<string>();
        const consume = (runId: string | undefined) => {
          assert(runId, 'Missing receipt correlation'); assert(!consumed.has(runId), 'Duplicate consumption');
          const matched = results.filter(item => item.runId === runId); assert.equal(matched.length, 1);
          const item = matched[0]; assert(item); consumed.add(runId); return item;
        };
        receipts.forEach((receipt, index) => {
          assert.equal(terminals[index]?.status, 'ok');
          const item = consume(receipt.runId); assert.equal(item.sessionKey, receipt.sessionKey);
          assert.throws(() => consume(receipt.runId), /Duplicate consumption/);
        });
        assert.throws(() => consume(undefined), /Missing receipt correlation/);
        assert.equal(hooks.length, 2); assert.equal(results.length, 2);
        writeReport({ mapping: 'PASS', completion: 'BLOCKED', nativeRuns: 2, toolResults: 2,
          terminals: terminals.map(item => item.status), duplicateAndMissingRejected: true,
          observations: results.map(({ result: _result, ...binding }) => binding),
          unprovenAuthority: ['original admission/delegated authority', 'runGeneration', 'sessionGeneration', 'caller authority'],
          limits: 'Fixture/system origin and synthetic domain observations only; no Completion or DomainResult is manufactured; G1(b)/G2/G11 remain open.' });
      } catch (error) { writeReport({ mapping: 'BLOCKED', hooks, validatedResults: results.length,
        error: error instanceof Error ? error.message : 'Fixture failed' }); }
    }, { timeoutMs: 100_000 });
  },
};

export async function worker(target: 'native-correlation' | 'main-interception' | 'whatsapp-response-delivery' = 'native-correlation') {
  isolated();
  const correlation = target === 'native-correlation';
  const codeModeOnly = process.env.BENSON_NATIVE_CODE_MODE_ONLY === '1';
  const completionV6Only = !!process.env.BENSON_NATIVE_COMPLETION_V6_ONLY;
  const completionCancellation = process.env.BENSON_NATIVE_COMPLETION_V6_ONLY === 'cancel';
  const supportedNativeOnly = process.env.BENSON_NATIVE_SUPPORTED_RESPONSE_ONLY === '1';
  const mainHookSurfaceOnly = process.env.BENSON_NATIVE_MAIN_HOOK_SURFACE_ONLY === '1';
  const whatsappMonitorOnly = process.env.BENSON_NATIVE_WHATSAPP_MONITOR_ONLY === '1';
  const whatsappInstallerOnly = process.env.BENSON_NATIVE_WHATSAPP_INSTALLER_ONLY === '1';
  assert(!whatsappInstallerOnly || (whatsappMonitorOnly && target === 'whatsapp-response-delivery'));
  assert(!completionV6Only || correlation);
  assert(!codeModeOnly || !correlation);
  assert(!mainHookSurfaceOnly || (!correlation && !codeModeOnly && !completionV6Only));
  const exposedTools = whatsappInstallerOnly ? ['jessica_task'] : completionV6Only ? ['jessica_read', 'jessica_task'] : correlation ? ['jessica_read'] : ['jessica_read', 'jessica_task', 'reminder_task'];
  assert.equal(JSON.parse(readFileSync('/repo/node_modules/openclaw/package.json', 'utf8')).version, '2026.10.4');
  for (const path of ['/tmp/home', '/tmp/state', '/tmp/workspace', '/tmp/plugin']) mkdirSync(path, { recursive: true });
  if (whatsappInstallerOnly) {
    console.error('Isolated WhatsApp: native install');
    // Original managed installer owns dependency resolution, provenance and trust.
    // Only public cached packages are available; scripts and external routes are absent.
    cpSync('/npm-cache-seed', '/tmp/home/.npm', { recursive: true });
    writeFileSync('/tmp/user.npmrc', ''); writeFileSync('/tmp/global.npmrc', '');
    writeFileSync('/tmp/config.json', JSON.stringify({ gateway: { mode: 'local', bind: 'loopback', auth: { mode: 'none' } },
      plugins: { slots: { memory: 'none' } }, discovery: { mdns: { mode: 'off' } } }));
    const cli = '/repo/node_modules/openclaw/openclaw.mjs';
    execFileSync('/usr/bin/node', [cli, 'plugins', 'install', 'npm:@openclaw/whatsapp@2026.10.4', '--pin'], {
      encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
      env: { ...process.env, NPM_CONFIG_OFFLINE: 'true', NPM_CONFIG_USERCONFIG: '/tmp/user.npmrc',
        NPM_CONFIG_GLOBALCONFIG: '/tmp/global.npmrc', NPM_CONFIG_IGNORE_SCRIPTS: 'true',
        NPM_CONFIG_FETCH_RETRIES: '0', NPM_CONFIG_FETCH_TIMEOUT: '30000', SHELL: '/usr/bin/sh' },
    });
    const inspection: unknown = JSON.parse(execFileSync('/usr/bin/node', [cli, 'plugins', 'inspect', 'whatsapp', '--json'], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    }));
    assert(record(inspection)); const { plugin, install } = inspection;
    assert(record(plugin) && record(install) && record(plugin.trust));
    const manifest = JSON.parse(readFileSync('/whatsapp-response-controller/manifest.json', 'utf8')) as {
      version: string; package: string; integrity: string; target: string; beforeSha256: string; afterSha256: string;
    };
    assert.equal(plugin.trustedOfficialInstall, true); assert.equal(plugin.trust.reason, 'trusted-official');
    assert.equal(plugin.trust.installSource, 'npm'); assert.equal(plugin.packageName, manifest.package);
    assert.equal(plugin.version, manifest.version); assert.equal(install.resolvedVersion, manifest.version);
    assert.equal(install.integrity, manifest.integrity); assert.equal(install.resolvedName, manifest.package);
    assert.equal(typeof plugin.rootDir, 'string'); const root = plugin.rootDir as string;
    assert(root.startsWith('/tmp/state/npm/projects/') && !root.split('/').includes('..'));
    assert.equal(install.installPath, root);
    const hash = () => createHash('sha256').update(readFileSync(`${root}/${manifest.target}`)).digest('hex');
    assert.equal(hash(), manifest.beforeSha256);
    execFileSync('/usr/bin/patch', ['--batch', '--fuzz=0', '--forward', '-p1', '-d', root,
      '--input', '/whatsapp-response-controller/2026.10.4.patch'], { stdio: 'pipe' });
    assert.equal(hash(), manifest.afterSha256);
    writeFileSync('/tmp/native-install-evidence.json', JSON.stringify({ root, version: plugin.version,
      integrity: install.integrity, trustedOfficialInstall: true, trustReason: plugin.trust.reason, patchedSha256: hash() }));
    console.error('Isolated WhatsApp: native install and patch verified');
  }
  let requests = 0;
  const providerScenarios: string[] = [];
  const fallbackModels: string[] = [];
  const mainReadCarriers: { marker: string; tool: string; callId: string; value: unknown }[] = [];
  const contractFailures: string[] = [];
  const provider = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.method, 'POST');
      let body = ''; for await (const chunk of req) { body += String(chunk); assert(body.length <= 256 * 1024); }
      assert(++requests <= (correlation ? 8 : codeModeOnly ? 10 : 30), 'Provider request bound exceeded');
      const input: unknown = JSON.parse(body); assert(record(input)); assert(Array.isArray(input.messages));
      assert(input.tools === undefined || Array.isArray(input.tools));
      const codeMode = /G3_MAIN_READ_CODE_/u.test(JSON.stringify(input.messages));
      assert(!codeMode || codeModeOnly, 'Code Mode needs its own isolated host configuration');
      const completionParent = completionV6Only && JSON.stringify(input.messages).includes('G3_MAIN_READ_V6');
      assert.deepEqual((input.tools ?? []).map((tool: unknown) => {
        assert(record(tool) && record(tool.function)); return tool.function.name;
      }), completionV6Only ? completionParent ? ['jessica_task'] : ['jessica_read'] : codeMode ? ['exec', 'wait'] : correlation || /G3_(HANDLED_TOOL_FAILURE|MAIN_READ_)/.test(JSON.stringify(input.messages)) ? exposedTools : [], 'The fixture must expose only its approved tools');
      // These markers control only this synthetic provider's test behavior.
      // They supply no admission, execution or Response authority.
      const content = JSON.stringify(whatsappMonitorOnly ? input.messages.findLast((message: unknown) =>
        record(message) && message.role === 'user' && /G3_(BOUNDED_SUCCESS|TERMINAL_NATIVE_FALLBACK|MAIN_READ_JESSICA)/u.test(JSON.stringify(message))) : input.messages);
      assert(!whatsappMonitorOnly || typeof content === 'string', 'Monitor provider requires its actual fixture input');
      const scenario = !correlation && content.includes('G3_TERMINAL_PROVIDER_ERROR') ? 'provider-error'
        : !correlation && content.includes('G3_TERMINAL_NATIVE_TIMEOUT') ? 'native-timeout'
        : !correlation && content.includes('G3_TERMINAL_PARTIAL_ABORT') ? 'partial-abort'
        : !correlation && content.includes('G3_TERMINAL_NATIVE_FALLBACK') ? 'native-fallback' : 'ordinary';
      providerScenarios.push(scenario);
      if (scenario === 'native-fallback') {
        assert(typeof input.model === 'string'); fallbackModels.push(input.model);
        assert(input.model === 'correlation' || input.model === 'secondary');
        if (input.model === 'correlation') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'model_not_found', message: 'Fixture model not found.' } }));
          return;
        }
      }
      if (scenario === 'provider-error') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Isolated provider rejected the fixture request.' } }));
        return;
      }
      const done = input.messages.some((item: unknown) => record(item) && item.role === 'tool');
      const readMarker = content.match(/G3_MAIN_READ_[A-Z_]+/u)?.[0];
      const readTools = readMarker ? codeMode || readMarker.endsWith('MULTI') ? ['jessica_task', 'reminder_task']
        : [readMarker.endsWith('REMINDER') ? 'reminder_task' : 'jessica_task'] : null;
      if (readTools && done) {
        const messages = input.messages.filter((item: unknown) => record(item) && item.role === 'tool');
        const calls = input.messages.flatMap((item: unknown) => record(item) && item.role === 'assistant' && Array.isArray(item.tool_calls) ? item.tool_calls : []);
        assert.equal(messages.length, codeMode ? 1 : readTools.length);
        assert.equal(calls.length, codeMode ? 1 : readTools.length);
        let guestValues: unknown[] = [];
        if (codeMode) {
          const call: unknown = calls[0], message: unknown = messages[0];
          assert(record(call) && record(call.function) && record(message));
          assert.equal(call.function.name, 'exec'); assert.equal(message.tool_call_id, call.id);
          assert(typeof message.content === 'string'); const completed: unknown = JSON.parse(message.content);
          assert(record(completed)); assert.equal(completed.status, 'completed');
          assert(Array.isArray(completed.value)); guestValues = completed.value;
          assert.equal(guestValues.length, readTools.length);
        }
        for (const [index, tool] of readTools.entries()) {
          const message: unknown = messages[codeMode ? 0 : index]; assert(record(message));
          const call: unknown = calls[codeMode ? 0 : index]; assert(record(call) && record(call.function));
          assert.equal(call.function.name, codeMode ? 'exec' : tool); assert(typeof call.id === 'string');
          // Native provider serialization may normalize call IDs. Match its actual
          // retained call/result pair; never derive host authority from that ID.
          assert.equal(message.tool_call_id, call.id);
          assert(typeof message.content === 'string'); const value: unknown = codeMode ? guestValues[index] : JSON.parse(message.content); assert(record(value));
          assert.equal(value.kind, 'benson.domain-result'); assert.equal(value.schemaVersion, 2);
          const failed = readMarker?.includes('JESSICA_FAILURE') && tool === 'jessica_task' ||
            readMarker?.includes('REMINDER_FAILURE') && tool === 'reminder_task';
          assert(record(value.facts)); assert.equal(value.facts.verified, !failed); assert(record(value.content));
          assert(record(value.outcome)); assert.equal(value.outcome.status, failed ? 'failure' : 'success');
          assert.equal(value.content.state, 'usable'); assert.equal(typeof value.content.text, 'string');
          assert(readMarker); mainReadCarriers.push({ marker: readMarker, tool, callId: call.id, value });
        }
      }
      const useTool = correlation || content.includes('G3_HANDLED_TOOL_FAILURE') || readTools !== null;
      let completionText: string | undefined;
      if (completionV6Only && !completionParent && done && !completionCancellation) {
        const message = input.messages.findLast((item: unknown) => record(item) && item.role === 'tool'); assert(record(message));
        assert(typeof message.content === 'string');
        const value = validateDomainResult(JSON.parse(message.content));
        completionText = JSON.stringify({ schemaVersion: 6, kind: 'domain-task', facts: completionFacts(value), userResponse: value.content });
      }
      const code = 'const results = []; results.push(await jessica_task({operation: "status"})); results.push(await reminder_task({operation: "list"})); return results;';
      const delta = !useTool ? { content: 'Native Main fixture reply.' } : done ? { content: completionText ?? 'Fixture finished.' } : codeMode ? {
        tool_calls: [{ index: 0, id: 'fixture-code-cell', type: 'function', function: { name: 'exec',
          arguments: JSON.stringify({ title: 'Read both fixture domains', code }) } }],
      } : {
        tool_calls: (readTools ?? ['jessica_read']).map((name, index) => ({ index, id: readTools ? `fixture-read-${index}` : 'fixture-call', type: 'function',
          function: { name, arguments: readTools ? JSON.stringify({ operation: name === 'jessica_task' ? 'status' : 'list' }) : '{}' } })) };
      assert.equal(input.stream, true);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const base = { id: `fixture-${requests}`, object: 'chat.completion.chunk', created: 1, model: 'correlation' };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
      if (scenario === 'native-timeout' || scenario === 'partial-abort') {
        if (scenario === 'partial-abort') res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0,
          delta: { content: 'Native partial before abort.' }, finish_reason: null }] })}\n\n`);
        // No terminal provider chunk: only the native deadline or the causal
        // AbortSignal may terminate this attempt. Teardown closes any sockets.
        return;
      }
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: !useTool || done ? 'stop' : 'tool_calls' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      if (contractFailures.length < 3) contractFailures.push(error instanceof Error ? error.message : 'Unknown contract failure');
      res.writeHead(400); res.end('Fixture provider contract rejected');
    }
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const address = provider.address(); assert(address && typeof address === 'object');
  writeFileSync('/tmp/plugin/openclaw.plugin.json', JSON.stringify({ id: pluginId, name: 'Disposable Jessica correlation fixture',
    activation: { onStartup: true },
    contracts: { tools: exposedTools },
    configSchema: { type: 'object', additionalProperties: false, properties: {} } }));
  writeFileSync('/tmp/plugin/package.json', JSON.stringify({ name: '@benson/disposable-correlation-fixture', version: '0.0.0', private: true,
    type: 'module', openclaw: { extensions: ['./index.mjs'] } }));
  writeFileSync('/tmp/plugin/index.mjs', `export { default } from '/repo/output/typescript/integrations/openclaw/benson-routing/tests/fixtures/${target}.js';\n`);
  const config: OpenClawPluginApi['config'] = { gateway: { mode: 'local', bind: 'loopback', port: 19491, auth: { mode: 'none' }, controlUi: { enabled: false } },
    ...correlation ? {} : { diagnostics: { flags: ['reply.profiler'] }, logging: { consoleLevel: 'debug' as const } },
    ...supportedNativeOnly ? { tts: { auto: 'off' as const } } : {},
    discovery: { mdns: { mode: 'off' } }, cron: { enabled: false },
    agents: { ...completionV6Only ? { ownership: 'explicit' as const } : {},
      defaults: { ...completionV6Only ? { systemAgent: { agentId: 'main' } } : {}, workspace: '/tmp/workspace', model: { primary: 'fixture-local/correlation',
      ...correlation ? {} : { fallbacks: ['fixture-local/secondary'] } }, skipBootstrap: true },
      entries: completionV6Only ? { main: { workspace: '/tmp/workspace' }, 'jessica-vacuum': { workspace: '/tmp/workspace' } }
        : { [correlation ? 'jessica-vacuum' : 'main']: { workspace: '/tmp/workspace' } } },
    tools: { allow: exposedTools, toolSearch: false, codeMode: codeModeOnly ? { enabled: true, executor: 'node' } : false },
    models: { providers: { 'fixture-local': { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'fixture-placeholder', authHeader: false,
      api: 'openai-completions', models: (correlation ? ['correlation'] : ['correlation', 'secondary']).map(id => ({
        id, name: 'Deterministic fixture', reasoning: false, input: ['text'] as ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 256 })) } } },
    ...whatsappMonitorOnly ? { channels: { whatsapp: { enabled: true, dmPolicy: 'allowlist' as const,
      allowFrom: ['+15550000001'], accounts: Object.fromEntries(Array.from({ length: whatsappInstallerOnly ? 18 : 8 }, (_, index) => [`fixture-${index}`, { authDir: `/tmp/empty-fixture-auth/fixture-${index}` }])), sendReadReceipts: false } } } : {},
    plugins: { allow: [pluginId, ...whatsappMonitorOnly ? ['whatsapp'] : []], slots: { memory: 'none' }, load: { paths: ['/tmp/plugin', ...whatsappMonitorOnly && !whatsappInstallerOnly ? ['/whatsapp'] : []] }, entries: { ...whatsappMonitorOnly ? { whatsapp: { enabled: true } } : {}, [pluginId]: { enabled: true,
      ...completionV6Only ? { hooks: { allowConversationAccess: true } } : {} } } } };
  if (whatsappInstallerOnly) {
    // Preserve the native install's config metadata/last-good lineage. A raw
    // replacement is correctly rejected and restored by native corruption checks.
    writeFileSync('/tmp/fixture-config.json', JSON.stringify(config));
    execFileSync('/usr/bin/node', ['/repo/node_modules/openclaw/openclaw.mjs', 'config', 'patch', '--file', '/tmp/fixture-config.json'], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    console.error('Isolated WhatsApp: fixture config applied through native CLI');
  } else writeFileSync('/tmp/config.json', JSON.stringify(config));
  const gateway = spawn('/usr/bin/node', [...whatsappMonitorOnly ? ['--import', '/repo/output/typescript/integrations/openclaw/benson-routing/tests/fixtures/whatsapp-response-delivery.js'] : [], '/repo/node_modules/openclaw/openclaw.mjs', 'gateway', 'run'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '', startupDiagnostics = '';
  for (const stream of [gateway.stdout, gateway.stderr]) stream.on('data', chunk => {
    startupDiagnostics = (startupDiagnostics + String(chunk)).slice(0, 12000);
    diagnostics = (diagnostics + String(chunk)).slice(-12000);
  });
  const exited = once(gateway, 'exit');
  const watcher = watch('/tmp');
  try {
    const deadline = AbortSignal.timeout(140_000);
    while (!existsSync(report)) {
      const waiter = new AbortController();
      try {
        const changed = once(watcher, 'change', { signal: AbortSignal.any([deadline, waiter.signal]) });
        if (!existsSync(report)) await Promise.race([changed,
          exited.then(([code]) => { throw new Error(`Fixture gateway exited (${code}); startup: ${startupDiagnostics}; last: ${diagnostics}`); })]);
        else await Promise.allSettled([changed, Promise.resolve().then(() => waiter.abort())]);
      }
      finally { waiter.abort(); }
    }
    const result: unknown = JSON.parse(readFileSync(report, 'utf8')); assert(record(result));
    assert.equal(result[completionV6Only ? 'completion' : correlation ? 'mapping' : 'probe'], 'PASS', JSON.stringify(result));
    if (mainHookSurfaceOnly) {
      assert.equal(requests, 0); assert.equal(mainReadCarriers.length, 0);
    } else if (target === 'whatsapp-response-delivery') {
      assert.equal(result.whatsappPlugin, '2026.10.4');
      assert(Array.isArray(result.cases));
      assert(result.cases.length >= (whatsappMonitorOnly ? 8 : 10));
    } else if (!correlation) {
      assert(Array.isArray(result.readAdmissionCases));
      assert.equal(result.readAdmissionCases.length, codeModeOnly ? 5 : 7); assert.equal(mainReadCarriers.length, codeModeOnly ? 10 : 11);
      for (const item of result.readAdmissionCases) {
        assert(record(item));
        assert(Array.isArray(item.values));
        const carriers = mainReadCarriers.filter(carrier => carrier.marker === item.marker);
        assert.equal(carriers.length, item.values.length); assert.deepEqual(carriers.map(carrier => carrier.value), item.values);
      }
    }
    console.log(JSON.stringify({ ...result, isolation: { externalInterfaces: 0, externalRoutes: 0, hostHomeVisible: false },
      providerRequests: requests, providerScenarios, fallbackModels, mainReadCarriers }));
  } catch (error) {
    throw new Error(`Fixture proof failed; providerRequests=${requests}; contractFailures=${JSON.stringify(contractFailures)}; startup: ${startupDiagnostics}; gateway diagnostics: ${diagnostics}`, { cause: error });
  } finally {
    watcher.close(); gateway.kill('SIGTERM');
    const kill = setTimeout(() => gateway.kill('SIGKILL'), 10_000);
    try { await exited; } finally { clearTimeout(kill); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); }
  }
}
// The stock plugin loader requires a synchronous ESM import graph.
// Start the coordinator only for its explicit worker invocation, without TLA.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--worker') {
  void worker().catch(error => { console.error(error); process.exitCode = 1; });
}
