import assert from 'node:assert/strict';
import test from 'node:test';
import { retainToolExecutionEvidence, readToolExecutionEvidence, receiptDomainValue, type ToolExecutionCoverage } from '../core/tool-execution-evidence.js';
import { runIsolatedFixture } from './fixtures/native-isolation.js';
const identity = { runId: 'run', sessionKey: 'session', sessionId: 'session-id', agentId: 'agent' };
test('untrusted DTO, incomplete/missing/duplicate/foreign receipts never establish coverage', () => {
  const receipt = { ordinal: 0, attempt: 1, callId: 'call', name: 'tool', originalArgs: {}, validatedArgs: {}, executionArgs: {},
    executionStarted: true, originalIsError: false, originalResult: { content: [] }, isError: false, result: { content: [] } };
  const base: ToolExecutionCoverage = { version: 1, identity, receipts: [receipt], seal: { complete: true, count: 1, attempts: 1 } };
  assert.throws(() => readToolExecutionEvidence(base, identity), /missing/);
  for (const fault of ['unsealed', 'missing', 'duplicate', 'identity', 'version', 'args', 'ordinal'] as const) {
    const value = structuredClone(base);
    if (fault === 'unsealed') Reflect.set(value.seal, 'complete', false);
    if (fault === 'missing') Reflect.set(value, 'receipts', []);
    if (fault === 'duplicate') { Reflect.set(value, 'receipts', [receipt, { ...receipt, ordinal: 1 }]); Reflect.set(value.seal, 'count', 2); }
    if (fault === 'identity') Reflect.set(value.identity, 'runId', 'other');
    if (fault === 'version') Reflect.set(value, 'version', 2);
    if (fault === 'args') Reflect.deleteProperty(value.receipts[0]!, 'executionArgs');
    if (fault === 'ordinal') Reflect.set(value.receipts[0]!, 'ordinal', 2);
    assert.throws(() => readToolExecutionEvidence(retainToolExecutionEvidence(() => value, () => {}), identity), fault);
  }
  let current = true;
  const handle = retainToolExecutionEvidence(() => base, () => { assert(current); });
  assert.equal(readToolExecutionEvidence(handle, identity).receipts.length, 1);
  current = false; assert.throws(() => readToolExecutionEvidence(handle, identity));
});
test('pinned isolated OpenClaw proves complete multi-tool native receipts and negative dispositions', { skip: process.env.BENSON_RECEIPT_NATIVE !== '1' }, () => {
  const result = runIsolatedFixture('tool-execution-receipts') as { mapping: string; cases: string[] };
  assert.equal(result.mapping, 'PASS'); assert.equal(result.cases.length, 10);
  console.log(JSON.stringify(result));
});

import { createOpenClawDomainRunCollector } from '../adapters/openclaw/tool-execution-evidence.js';

function collectionHost(readOnly = false, nativeSeal = false) {
  const hooks = new Map<string, unknown>(), disposals: (() => unknown)[] = [], abort = new AbortController();
  const api: Parameters<typeof createOpenClawDomainRunCollector>[0] = {
    on(name, handler) { assert(!hooks.has(name)); hooks.set(name, handler); },
    lifecycle: { signal: abort.signal, onDispose(callback) { disposals.push(callback); return () => {}; } },
  };
  const collector = createOpenClawDomainRunCollector(api, { agentId: 'reminder-service', tools: ['domain_read'],
    ...nativeSeal ? { terminalSource: 'native-seal' as const } : {},
    ...readOnly ? { readOnly: { name: 'domain_read', validate(receipt: Readonly<import('../core/tool-execution-evidence.js').ToolExecutionReceipt>) {
      assert.deepEqual(receipt.executionArgs, receipt.originalArgs);
      const value = receiptDomainValue(receipt);
      assert.deepEqual(JSON.parse(JSON.stringify(value)), JSON.parse(JSON.stringify(receipt.executionArgs)));
      return value;
    } } } : {} });
  return { collector, abort, dispose() { disposals.forEach(callback => callback()); },
    emit(name: string, event: unknown, context: unknown) {
      const handler = hooks.get(name); assert.equal(typeof handler, 'function');
      if (typeof handler !== 'function') throw new Error('Missing hook');
      return handler(event, context);
    } };
}
function collectionRun(host: ReturnType<typeof collectionHost>, label: string, count = 3) {
  const state = { current: true };
  const identity = { runId: 'run-' + label, sessionKey: 'agent:reminder-service:subagent:' + label,
    sessionId: 'session-' + label, agentId: 'reminder-service' };
  const scope = host.collector.begin(identity.sessionKey, () => { assert(state.current, 'original source retired'); });
  const calls = Array.from({ length: count }, (_, i) => ({ id: 'call-' + i, index: i }));
  const context = (id: string) => ({ ...identity, toolCallId: id });
  const event = (id: string) => ({ toolName: 'domain_read', toolCallId: id, runId: identity.runId, params: {} });
  const coverage: ToolExecutionCoverage = { version: 1, identity, seal: { complete: true, count, attempts: 1 },
    receipts: calls.map(call => ({ ordinal: call.index, attempt: 1, callId: call.id, name: 'domain_read',
      originalArgs: { index: call.index }, validatedArgs: { index: call.index }, executionArgs: { index: call.index },
      executionStarted: true, originalIsError: false, isError: false,
      originalResult: { content: [], details: { index: call.index } }, result: { content: [], details: { index: call.index } } })) };
  const evidence = retainToolExecutionEvidence(() => coverage, () => { assert(state.current); });
  const before = (id: string) => host.emit('before_tool_call', event(id), context(id));
  const record = (call: typeof calls[number]) => scope.record(context(call.id), call.id, 'domain_read', { index: call.index },
    (args, value) => { assert.deepEqual(JSON.parse(JSON.stringify(args)), { index: call.index });
      assert.deepEqual(JSON.parse(JSON.stringify(value)), { index: call.index }); });
  const after = (id: string) => host.emit('after_tool_call', { ...event(id), result: { redacted: true } }, context(id));
  const terminal = () => host.emit('agent_end', { success: true, messages: [] }, identity);
  return { state, identity, scope, calls, context, event, coverage, evidence, before, record, after, terminal };
}

test('native collection isolates concurrent Runs and orders domain witnesses by authoritative receipts', () => {
  const h = collectionHost(), a = collectionRun(h, 'a'), b = collectionRun(h, 'b', 5);
  for (const run of [a, b]) for (const call of run.calls) assert.equal(run.before(call.id), undefined);
  for (const run of [b, a]) for (const call of [...run.calls].reverse()) { run.record(call); run.after(call.id); }
  b.terminal(); a.terminal();
  const retained = [a, b].map(run => {
    const result = run.scope.complete(run.identity, run.evidence);
    assert.deepEqual(result.observations.map(observation => observation.tool.callId), run.calls.map(call => call.id));
    for (const [i, observation] of result.observations.entries()) result.validateTool(observation.tool, run.coverage.receipts[i]);
    run.scope.release(); assert.throws(() => run.scope.assertExecuting(), /execution_retired/);
    assert.doesNotThrow(() => result.custody.assertCurrent());
    return result;
  });
  a.state.current = false;
  assert.throws(() => retained[0]!.custody.assertCurrent(), /source retired/);
  assert.doesNotThrow(() => retained[1]!.custody.assertCurrent());
  h.dispose(); assert.throws(() => retained[1]!.custody.assertCurrent(), /collection_retired/);
});

test('native collection stale cleanup cannot remove a replacement session scope', () => {
  const h = collectionHost(), previous = collectionRun(h, 'replacement', 0);
  previous.terminal(); previous.scope.complete(previous.identity, previous.evidence); previous.scope.release();
  const next = collectionRun(h, 'replacement', 1);
  previous.scope.release(); previous.scope.discard();
  const call = next.calls[0]!;
  assert.equal(next.before(call.id), undefined); next.record(call); next.after(call.id); next.terminal();
  assert.equal(next.scope.complete(next.identity, next.evidence).observations.length, 1);
  next.scope.release(); h.dispose();
});

for (const fault of ['missing-before', 'missing-after', 'missing-witness', 'duplicate-before', 'duplicate-after',
  'duplicate-witness', 'foreign-context', 'foreign-receipt', 'missing-receipt', 'unsealed', 'duplicate-terminal',
  'terminal-identity', 'source-retired'] as const) {
  test('native collection rejects unverifiable custody: ' + fault, () => {
    const h = collectionHost(), r = collectionRun(h, fault, 1), call = r.calls[0]!;
    if (fault !== 'missing-before') r.before(call.id);
    if (fault === 'duplicate-before') assert.deepEqual(r.before(call.id), { block: true, blockReason: 'Native domain invocation evidence unavailable.' });
    if (fault === 'foreign-context') h.emit('after_tool_call', r.event(call.id), { ...r.context(call.id), runId: 'foreign' });
    if (fault !== 'missing-witness') {
      if (['missing-before', 'duplicate-before', 'foreign-context'].includes(fault)) assert.throws(() => r.record(call));
      else r.record(call);
    }
    if (fault === 'duplicate-witness') assert.throws(() => r.record(call), /witness_unverified/);
    if (fault !== 'missing-after') r.after(call.id);
    if (fault === 'duplicate-after') r.after(call.id);
    if (fault === 'terminal-identity') h.emit('agent_end', { success: true, messages: [] }, { ...r.identity, sessionId: 'foreign' });
    else r.terminal();
    if (fault === 'duplicate-terminal') r.terminal();
    if (fault === 'foreign-receipt') Reflect.set(r.coverage.identity, 'runId', 'foreign');
    if (fault === 'missing-receipt') Reflect.set(r.coverage, 'receipts', []);
    if (fault === 'unsealed') Reflect.set(r.coverage.seal, 'complete', false);
    if (fault === 'source-retired') r.state.current = false;
    assert.throws(() => r.scope.complete(r.identity, r.evidence), fault);
    r.scope.discard(); h.dispose();
  });
}

test('native collection vetoes tool overflow, unadmitted tools and retired source before dispatch', () => {
  for (const mode of ['overflow', 'tool', 'source'] as const) {
    const h = collectionHost(), r = collectionRun(h, mode, 64);
    if (mode === 'overflow') for (const call of r.calls) assert.equal(r.before(call.id), undefined);
    if (mode === 'source') r.state.current = false;
    const result = mode === 'tool' ? h.emit('before_tool_call', { ...r.event('extra'), toolName: 'unadmitted' }, r.context('extra')) : r.before('extra');
    assert.deepEqual(result, { block: true, blockReason: 'Native domain invocation evidence unavailable.' });
    assert.throws(() => r.scope.assertExecuting()); r.scope.discard(); h.dispose();
  }
});

test('native collection keeps zero calls explicit and bounds live scopes with deterministic release', () => {
  const h = collectionHost(), runs = Array.from({ length: 8 }, (_, i) => collectionRun(h, String(i), 0));
  assert.throws(() => collectionRun(h, 'overflow'), /scope_unavailable/);
  for (const r of runs) { r.terminal(); const result = r.scope.complete(r.identity, r.evidence);
    assert.deepEqual(result.observations, []); r.scope.release(); }
  const next = collectionRun(h, 'next', 0); next.scope.discard(); h.dispose();
});

test('native collection rejects mutable observation substitution and asynchronous domain witnesses', () => {
  for (const mode of ['mutation', 'async'] as const) {
    const h = collectionHost(), r = collectionRun(h, mode, 1), call = r.calls[0]!;
    r.before(call.id);
    if (mode === 'async') r.scope.record(r.context(call.id), call.id, 'domain_read', { index: 0 }, async () => {});
    else r.record(call);
    r.after(call.id); r.terminal(); const result = r.scope.complete(r.identity, r.evidence), observation = result.observations[0]!;
    if (mode === 'mutation') Reflect.set(observation.tool, 'value', { index: 99 });
    assert.throws(() => result.validateTool(observation.tool, r.coverage.receipts[0]));
    r.scope.release(); h.dispose();
  }
});

// Pure-read evidence is an explicit domain validation profile. It does not
// substitute for the existing factory witness on mutations/default collectors.
for (const fault of ['none', 'arguments', 'result', 'error', 'not-executed', 'after', 'foreign', 'source'] as const) {
  test('explicit read profile validates native originals and retains custody: ' + fault, () => {
    const h = collectionHost(true), r = collectionRun(h, 'read-' + fault, 1), call = r.calls[0]!;
    r.before(call.id);
    if (fault !== 'after') r.after(call.id);
    r.terminal();
    const receipt = r.coverage.receipts[0]!;
    if (fault === 'arguments') Reflect.set(receipt, 'executionArgs', { index: 99 });
    if (fault === 'result') Reflect.set(receipt, 'originalResult', { content: [], details: { index: 99 } });
    if (fault === 'error') Reflect.set(receipt, 'isError', true);
    if (fault === 'not-executed') Reflect.set(receipt, 'executionStarted', false);
    if (fault === 'foreign') Reflect.set(receipt, 'name', 'domain_execute');
    if (fault === 'source') r.state.current = false;
    if (fault !== 'none') assert.throws(() => r.scope.complete(r.identity, r.evidence));
    else {
      const result = r.scope.complete(r.identity, r.evidence), observation = result.observations[0]!;
      result.validateTool(observation.tool, receipt);
      assert.throws(() => result.validateTool({ ...observation.tool, value: { index: 99 } }, receipt));
      r.scope.release(); result.custody.assertCurrent();
      r.state.current = false; assert.throws(() => result.validateTool(observation.tool, receipt));
    }
    r.scope.discard(); h.dispose();
  });
}

for (const fault of ['none', 'missing', 'foreign-run', 'foreign-session', 'failed', 'oversized', 'mixed-hook'] as const) {
  test('seal terminal profile requires exact bounded native terminal: ' + fault, () => {
    const h = collectionHost(false, true), r = collectionRun(h, 'seal-' + fault, 1), call = r.calls[0]!;
    r.before(call.id); r.record(call); r.after(call.id);
    const terminal = { runId: r.identity.runId, sessionKey: r.identity.sessionKey, sessionId: r.identity.sessionId, success: true, messages: [] as unknown[] };
    if (fault === 'foreign-run') terminal.runId = 'foreign';
    if (fault === 'foreign-session') terminal.sessionId = 'foreign';
    if (fault === 'failed') terminal.success = false;
    if (fault === 'oversized') terminal.messages = Array.from({ length: 1025 }, () => ({}));
    if (fault === 'mixed-hook') r.terminal();
    if (fault !== 'none') assert.throws(() => r.scope.complete(r.identity, r.evidence, fault === 'missing' ? undefined : terminal));
    else {
      const result = r.scope.complete(r.identity, r.evidence, terminal);
      assert.deepEqual(result.terminal, terminal);
      r.scope.release(); result.custody.assertCurrent();
      r.state.current = false; assert.throws(() => result.custody.assertCurrent());
    }
    r.scope.discard(); h.dispose();
  });
}

for (const fault of ['none', 'foreign', 'missing', 'duplicate', 'incomplete', 'attempts', 'arguments', 'result', 'error', 'not-executed', 'source', 'cancelled', 'disposed'] as const) {
  test('sealed pure-read profile uses actual receipts without optional plugin hooks: ' + fault, () => {
    const h = collectionHost(true, true), r = collectionRun(h, 'sealed-read-' + fault, 3);
    const terminal = { runId: r.identity.runId, sessionKey: r.identity.sessionKey,
      sessionId: r.identity.sessionId, success: true, messages: [] };
    if (fault === 'foreign') Reflect.set(r.coverage.receipts[0]!, 'name', 'domain_execute');
    if (fault === 'missing') Reflect.set(r.coverage, 'receipts', r.coverage.receipts.slice(0, -1));
    if (fault === 'duplicate') Reflect.set(r.coverage.receipts[1]!, 'callId', r.calls[0]!.id);
    if (fault === 'incomplete') Reflect.set(r.coverage.seal, 'complete', false);
    if (fault === 'attempts') Reflect.set(r.coverage.seal, 'attempts', 2);
    if (fault === 'arguments') Reflect.set(r.coverage.receipts[0]!, 'executionArgs', { index: 99 });
    if (fault === 'result') Reflect.set(r.coverage.receipts[0]!, 'originalResult', { content: [], details: { index: 99 } });
    if (fault === 'error') Reflect.set(r.coverage.receipts[0]!, 'isError', true);
    if (fault === 'not-executed') Reflect.set(r.coverage.receipts[0]!, 'executionStarted', false);
    if (fault === 'source') r.state.current = false;
    if (fault === 'cancelled') h.abort.abort();
    if (fault === 'disposed') h.dispose();
    if (fault !== 'none') assert.throws(() => r.scope.complete(r.identity, r.evidence, terminal));
    else {
      const result = r.scope.complete(r.identity, r.evidence, terminal);
      assert.equal(result.observations.length, 3);
      result.observations.forEach((observation, index) => result.validateTool(observation.tool, r.coverage.receipts[index]));
      r.scope.release(); result.custody.assertCurrent();
      r.state.current = false; assert.throws(() => result.custody.assertCurrent());
    }
    r.scope.discard(); h.dispose();
  });
}
