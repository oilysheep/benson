import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { createCompletionAuthority, acceptAgentCompletion, validateCompletion } from '../envelope.mjs';

// Run explicitly against an independent patched package with isolated native
// state/config. This suite must never install patches or touch production state.
const root = process.env.OPENCLAW_PACKAGE_ROOT;
const nativeTest = root ? test : test.skip;
const load = async (file) => import(pathToFileURL(join(root, 'dist', file)).href);
const registry = root && await load('agent-run-registry-DO6Dg2r0.mjs');
const admission = root && await load('admitted-run-context-BNasoszr.mjs');
const events = root && await load('agent-events-BOSJcayE.mjs');
const tools = root && await load('agent-tools.before-tool-call-D6M7yTR3.mjs');
let sequence = 0;
const plain = (value) => JSON.parse(JSON.stringify(value));
const finalFacts = { status: 'not_applicable', domain: null, domainSchemaVersion: null,
  operation: null, verified: 'not_applicable', verificationScope: [], data: null,
  warnings: [], error: null, effects: [], uncertainty: [], pendingContext: null };
const domainFacts = { status: 'success', domain: 'jessica-vacuum', domainSchemaVersion: '1',
  operation: 'clean', verified: true, verificationScope: ['command_started'],
  data: { operationId: 'fixture-op', started: true }, warnings: [], error: null,
  effects: [{ kind: 'command_started', operationId: 'fixture-op' }],
  uncertainty: [{ kind: 'physical_completion_not_established' }], pendingContext: null };
async function fixture(agentId = 'main', { coverage = true, scheduled = false, domain = false } = {}) {
  const runId = `r03-native-fixture-${++sequence}`;
  const params = { runId, agentId, sessionKey: `agent:${agentId}:r03-fixture-${sequence}`,
    sessionId: `r03-session-${sequence}`, config: {}, provider: 'fixture', model: 'fixture',
    lifecycleGeneration: registry.d() };
  registry._(runId, params);
  params.preparedRunAdmission = admission.l({}, runId, agentId,
    scheduled ? 'cron.isolated-agent' : 'r03.fixture');
  const admitted = await params.preparedRunAdmission.admit('embedded');
  const authority = registry.s(admitted.operationalRunInstance);
  assert.equal(registry.O(authority), true);
  const context = registry.c(runId);
  registry.bindBensonNativeManagedRun(admitted);
  const binding = { requestId: `fixture-request-${sequence}`, workflowId: `fixture-workflow-${sequence}`,
    runId, agentId, sessionKey: domain ? 'agent:main:r03-caller' : params.sessionKey,
    sessionId: domain ? 'r03-caller-session' : params.sessionId,
    instanceId: admitted.operationalRunInstance.instanceId, lifecycleGeneration: authority.lifecycleGeneration,
    taskId: domain ? `fixture-task-${sequence}` : null, callerRunId: domain ? 'fixture-caller' : null,
    completionTarget: domain ? 'CALLER' : 'RESPONSE_CONTROLLER', finality: !domain,
    authorizationId: 'fixture-native-authorization', deliveryPolicy: { eligible: false, reason: 'FIXTURE_ONLY' } };
  // Semantic facts/routes are host fixtures, NOT model data and NOT proof of the
  // future R05/R06 adapters or real domain execution/delivery.
  context.bensonCompletionEvidence = { kind: domain ? 'domain-task' : 'final-workflow', binding,
    knownFacts: plain(domain ? domainFacts : finalFacts), results: [], coverage: 'complete', gaps: [] };
  const attempt = registry.beginAgentRunExecutionEvidence(admitted, coverage);
  const proposal = { schemaVersion: 3, kind: context.bensonCompletionEvidence.kind,
    facts: plain(context.bensonCompletionEvidence.knownFacts),
    userResponse: { state: 'usable', text: 'Fixture owner message.', language: 'en' } };
  return { params, context, admitted, authority, attempt, proposal,
    result: (candidate = proposal) => ({ payloads: [{ text: typeof candidate === 'string' ? candidate : JSON.stringify(candidate) }],
      meta: { durationMs: 1 } }) };
}
function nativeFunction(file, name, injected) {
  const source = readFileSync(join(root, 'dist', file), 'utf8');
  const body = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`, 'u'))?.[0];
  assert.ok(body, `${name} missing from native package`);
  return new vm.Script(`(${body})`).runInNewContext({ Buffer, ...injected });
}
function entry(kind, execute) {
  const common = { captureAgentRunLifecycleGeneration: () => registry.d(),
    withAgentRunLifecycleGeneration: events.y, withBensonNativeCompletion: registry.withBensonNativeCompletion,
    guardBensonNativeAgentCallbacks: registry.guardBensonNativeAgentCallbacks };
  if (kind === 'embedded') return nativeFunction('embedded-agent-BaH7wGBd.mjs', 'runEmbeddedAgent', {
    ...common, normalizeOptionalString: (v) => v?.trim(), getRuntimeConfigSnapshot: () => ({}),
    getPreparedModelRuntimePluginGeneration: () => undefined, runEmbeddedAgentInternal: execute,
  });
  return nativeFunction('cli-runner-DQ-f1RtK.mjs', 'runCliAgent', {
    ...common, isClaudeCliBackend: () => false, runCliAgentInternal: execute,
  });
}


nativeTest('ordinary native embedded and CLI runs retain raw success, callbacks and errors', async () => {
  for (const kind of ['embedded', 'cli']) {
    const runId = 'r03-native-unmanaged-' + ++sequence;
    const params = { runId, agentId: 'ordinary-agent', sessionKey: 'agent:ordinary-agent:fixture',
      sessionId: 'ordinary-session', lifecycleGeneration: registry.d() };
    registry._(runId, params);
    params.preparedRunAdmission = admission.l({}, runId, params.agentId, 'ordinary.fixture');
    await params.preparedRunAdmission.admit('embedded');
    const seen = [];
    params.onAgentEvent = event => seen.push(event);
    params.onBlockReply = reply => seen.push(reply);
    assert.equal(registry.guardBensonNativeAgentCallbacks(params), params);
    const plainResult = { payloads: [{ text: 'ordinary native final' }],
      meta: { finalAssistantRawText: 'ordinary native final' } };
    const run = entry(kind, async received => {
      received.onAgentEvent?.({ runId, stream: 'assistant', data: { text: 'ordinary progress' } });
      received.onBlockReply?.({ text: 'ordinary block' });
      return plainResult;
    });
    assert.equal(await run(params), plainResult);
    assert.deepEqual(seen.map(item => item.data?.text ?? item.text),
      ['ordinary progress', 'ordinary block']);
    assert.equal(registry.c(runId).bensonCompletionBoundary, undefined);
    const failure = new Error('ordinary native failure');
    await assert.rejects(entry(kind, async () => { throw failure; })(params),
      error => error === failure);
    assert.equal(failure.bensonCompletion, undefined);
    assert.equal(registry.c(runId).bensonCompletionBoundary, undefined);
  }
});

nativeTest('ordinary pre-boundary native failures retain their original error', async () => {
  for (const kind of ['embedded', 'cli']) {
    const error = new Error('native admission failed');
    let reached = 0;
    const run = entry(kind, async () => { reached++; throw error; });
    await assert.rejects(run({ runId: 'r03-unmanaged-unadmitted-' + ++sequence,
      agentId: 'ordinary-agent' }), actual => actual === error);
    assert.equal(reached, 1);
  }
});

for (const kind of ['embedded', 'cli']) {
  for (const agentId of ['main', 'jessica-vacuum', 'reminder-service', 'future-fixture']) {
    nativeTest(`${kind}: native entry enforces completion for ${agentId} without a private hook`, async () => {
      const f = await fixture(agentId, { domain: agentId === 'jessica-vacuum', scheduled: agentId === 'reminder-service' });
      f.attempt.settle(true);
      const run = entry(kind, async () => f.result());
      const result = await run(f.params);
      assert.equal(result.meta.bensonCompletion.completion.outcome, 'NORMAL');
      assert.equal(result.meta.bensonCompletion.binding.instanceId, f.admitted.operationalRunInstance.instanceId);
      assert.equal(result.meta.bensonCompletion.binding.lifecycleGeneration, f.authority.lifecycleGeneration);
      assert.deepEqual(JSON.parse(result.payloads[0].text), plain(result.meta.bensonCompletion));
      assert.equal(result.meta.bensonCompletion.userResponse.text, 'Fixture owner message.');
    });
  }
  for (const invalid of ['ordinary prose', '{invalid-json', { schemaVersion: 3, kind: 'final-workflow' }]) {
    nativeTest(`${kind}: malformed/plain/missing-field terminal cannot leave as raw completion: ${JSON.stringify(invalid)}`, async () => {
      const f = await fixture('jessica-vacuum', { domain: true });
      f.attempt.settle(true);
      const result = await entry(kind, async () => f.result(invalid))(f.params);
      assert.equal(result.meta.bensonCompletion.completion.outcome, 'RECOVERED');
      assert.equal(result.meta.bensonCompletion.facts.status, 'success');
      assert.deepEqual(plain(result.meta.bensonCompletion.facts.effects), domainFacts.effects);
      assert.equal(result.meta.bensonCompletion.userResponse.state, 'unavailable');
    });
  }
}

nativeTest('actual native UUID bindings reject serialized completion from replacement/lifecycle', async () => {
  const f = await fixture(); f.attempt.settle(true);
  const evidence = f.context.bensonCompletionEvidence;
  const accepted = acceptAgentCompletion(f.proposal, createCompletionAuthority({ ...evidence, origin: 'agent' }));
  assert.match(accepted.binding.instanceId, /^[a-f\d-]{36}$/u);
  assert.match(accepted.binding.lifecycleGeneration, /^[a-f\d-]{36}$/u);
  for (const key of ['instanceId', 'lifecycleGeneration']) {
    const binding = { ...evidence.binding, [key]: admission.a('replacement').instanceId };
    assert.throws(() => validateCompletion(plain(accepted), createCompletionAuthority({ ...evidence, binding, origin: 'agent' })), /native_binding_mismatch/u);
  }
});

nativeTest('actual hidden native tool wrapper records execution without UI/diagnostic callbacks across attempts', async () => {
  const f = await fixture(); let executions = 0;
  const wrapped = tools.u({ name: 'r03_hidden_fixture_tool', label: 'Fixture', hideFromChannelProgress: true,
    description: 'Read-only fixture', parameters: { type: 'object', properties: {} },
    execute: async () => { executions++; return { content: [{ type: 'text', text: 'fixture' }] }; } },
    { runId: f.params.runId, sessionKey: f.params.sessionKey, config: {} }, { emitDiagnostics: false });
  await wrapped.execute('fixture-call-one', {});
  const first = f.attempt.settle(true);
  assert.equal(first.executionCount, 1); assert.equal(first.complete, true);
  const second = registry.beginAgentRunExecutionEvidence(f.admitted, true);
  await wrapped.execute('fixture-call-two', {});
  const last = second.settle(true);
  assert.equal(executions, 2); assert.equal(last.executionCount, 2); assert.equal(last.complete, true);
});

nativeTest('native nested executions count independently; incomplete/plugin coverage never certifies zero', async () => {
  const f = await fixture('future-fixture', { coverage: false });
  const nested = registry.recordAgentRunToolExecution(f.params.runId);
  const outer = registry.recordAgentRunToolExecution(f.params.runId);
  nested(); outer(); nested();
  const evidence = f.attempt.settle(true);
  assert.equal(evidence.executionCount, 2); assert.equal(evidence.complete, false);
  const result = await registry.withBensonNativeCompletion(f.params, async () => f.result());
  assert.equal(result.meta.bensonCompletion.completion.outcome, 'FAILED');
  assert.ok(result.meta.bensonCompletion.completion.gaps.some(g => g.code === 'EVIDENCE_COVERAGE_INCOMPLETE'));
  const zero = await fixture('future-fixture', { coverage: false }); zero.attempt.settle(true);
  const failed = await registry.withBensonNativeCompletion(zero.params, async () => zero.result());
  assert.equal(failed.meta.bensonCompletion.completion.outcome, 'FAILED');
});

for (const name of ['AbortError', 'TimeoutError', 'Error']) {
  nativeTest(`native ${name} finalizes retained evidence without reauthorizing execution or delivery`, async () => {
    const f = await fixture('jessica-vacuum', { domain: true }); f.attempt.settle(true);
    const error = new Error('fixture native terminal'); error.name = name;
    registry.x(f.authority); assert.equal(registry.O(f.authority), false);
    let calls = 0;
    await assert.rejects(registry.withBensonNativeCompletion(f.params, async () => { calls++; throw error; }), actual => {
      assert.equal(actual, error); assert.equal(actual.name, name);
      assert.equal(actual.bensonCompletion.completion.outcome, 'RECOVERED');
      assert.equal(actual.bensonCompletion.facts.status, 'success');
      assert.equal(actual.bensonCompletion.binding.deliveryPolicy.eligible, false);
      return true;
    });
    assert.equal(calls, 1); assert.equal(registry.O(f.authority), false);
  });
}

nativeTest('yield/wait is native nonterminal suspension, never canonical completion', async () => {
  for (const field of ['yielded', 'continuationPending']) {
    const f = await fixture();
    const result = { payloads: [], meta: { [field]: true } };
    const got = await registry.withBensonNativeCompletion(f.params, async () => result);
    assert.equal(got, result); assert.equal(got.meta.bensonCompletion, undefined);
    assert.equal(f.context.bensonCompletionBoundary.record, null);
    f.attempt.settle(true);
  }
});

nativeTest('embedded native suspension transfers continuation without terminal settlement or publication', async () => {
  const source = readFileSync(join(root, 'dist', 'embedded-agent-BaH7wGBd.mjs'), 'utf8');
  const start = source.indexOf('const bensonOwner = getAgentEventExecutionContext().getStore().bensonRunOwnership;');
  const end = source.indexOf('\n\t\t\t} catch (error)', start);
  assert.ok(start > 0 && end > start, 'native terminal owner must be extractable');
  const actions = [];
  const nativeTerminal = new vm.Script('(async (result) => { ' + source.slice(start, end) + ' })').runInNewContext({
    getAgentEventExecutionContext: registry.M,
    finishBensonNativeCompletion: registry.finishBensonNativeCompletion,
    retainRequesterContinuation: (_params, result, assertCurrent) => {
      assertCurrent(); assert.ok(result.meta.yielded || result.meta.continuationPending);
      actions.push('continuation');
    },
    settleRequesterRun: () => actions.push('terminal-settlement'),
    refresh: { mergeTerminalReceipt: () => actions.push('terminal-receipt') },
    terminal: { emit: () => actions.push('terminal-publication'), getDeferredError: () => undefined },
    params: { isFinalFallbackAttempt: undefined, preparedRunAdmission: { assertSourceCurrent: () => {} } },
    throwIfAborted: () => {}, resolveAgentLifecycleTerminalMetadata: () => ({})
  });
  for (const field of ['yielded', 'continuationPending']) {
    const f = await fixture(); f.attempt.settle(true);
    const observed = []; const off = events.f(event => {
      if (event.runId === f.params.runId) observed.push(event);
    });
    try {
      const result = { payloads: [], meta: { [field]: true } };
      assert.equal(await registry.withBensonNativeCompletion(f.params, () => nativeTerminal(result)), result);
      assert.deepEqual(actions.splice(0), ['continuation']);
      assert.equal(f.context.bensonCompletionBoundary.record, null);
      for (const phase of ['end', 'error']) assert.equal(events.s({ runId: f.params.runId,
        stream: 'lifecycle', data: { phase } }), false);
      assert.equal(observed.length, 0);
      const owner = registry.beginBensonNativeCompletion(f.params);
      registry.finishBensonNativeCompletion(owner, f.result());
      assert.equal(events.s({ runId: f.params.runId, stream: 'lifecycle',
        data: { phase: 'end' } }), true);
      assert.equal(observed.length, 1);
      assert.equal(observed[0].data.completionOutcome, 'NORMAL');
    } finally { off(); }
  }
  const ordinary = { payloads: [{ text: 'ordinary yielded text' }], meta: { yielded: true } };
  await events.y(registry.d(), () => nativeTerminal(ordinary));
  assert.deepEqual(actions.splice(0), ['terminal-receipt', 'terminal-settlement', 'terminal-publication']);
});

nativeTest('native publication gate scopes completion only to Benson-managed runs', async () => {
  const unmanagedRunId = 'r03-unmanaged-' + ++sequence;
  registry._(unmanagedRunId, { agentId: 'native-fixture', sessionKey: 'native:fixture', sessionId: 'native-session' });
  const seen = []; const off = events.f(event => { if (event.runId === unmanagedRunId) seen.push(event); });
  try {
    assert.equal(events.s({ runId: unmanagedRunId, stream: 'assistant', data: { text: 'native text' } }), true);
    for (const phase of ['end', 'error']) assert.equal(events.s({ runId: unmanagedRunId,
      stream: 'lifecycle', data: { phase } }), true);
    assert.deepEqual(seen.map(event => event.stream === 'assistant' ? 'assistant' : event.data.phase),
      ['assistant', 'end', 'error']);
    assert.equal(events.s({ runId: 'r03-unregistered-' + ++sequence, stream: 'lifecycle',
      data: { phase: 'error' } }), true);
  } finally { off(); }
  const managed = await fixture();
  assert.equal(managed.context.bensonCompletionBoundary, undefined);
  assert.equal(events.s({ runId: managed.params.runId, stream: 'assistant',
    data: { text: 'provisional Benson text' } }), false);
  assert.equal(events.s({ runId: managed.params.runId, stream: 'lifecycle',
    data: { phase: 'error' } }), false);
  assert.equal(events.s({ runId: managed.params.runId, stream: 'lifecycle',
    data: { phase: 'start', startedAt: Date.now() } }), true);
  managed.attempt.settle(true);
});

nativeTest('native publication rejects pre-finalization terminal through all public/audit emitter paths', async () => {
  const f = await fixture(); f.attempt.settle(true); registry.x(f.authority);
  const owner = registry.beginBensonNativeCompletion(f.params);
  const seen = []; const off = events.f(event => seen.push(event)); const offAudit = events.d(event => seen.push(event));
  try {
    const emit = () => ({ runId: f.params.runId, stream: 'lifecycle', data: { phase: 'end', endedAt: Date.now() } });
    const raw = () => ({ runId: f.params.runId, stream: 'assistant', data: { text: 'RAW_PRE_ACCEPTANCE' } });
    events.s(raw()); events.o(raw(), f.context); events.r(raw());
    events.s(emit()); events.o(emit(), f.context); events.r(emit());
    assert.equal(seen.length, 0);
    registry.finishBensonNativeCompletion(owner, f.result());
    events.s(raw()); events.o(raw(), f.context); events.r(raw());
    events.s(emit()); events.o(emit(), f.context); events.r(emit());
    assert.equal(seen.length, 3);
    for (const event of seen) assert.equal(event.data.completionOutcome, 'NORMAL');
  } finally { off(); offAudit(); }
});

nativeTest('handled reply is finalized before native observer recovery/delivery bookkeeping', async () => {
  const f = await fixture(); f.attempt.settle(true); let observed;
  const runHook = nativeFunction('auth-profile-failure-policy-BlqvJ9aj.mjs', 'runBeforeAgentReplyForTurn', {
    isPluginHookAgentTrigger: () => true, runOncePerAgentRun: events.v,
    getGlobalHookRunner: () => ({ hasHooks: () => true, runBeforeAgentReply: async () => ({ handled: true, reply: { text: 'ordinary hook prose' } }) }),
    beforeAgentReplyObserver: { getStore: () => ({ beforeDispatch: async () => true,
      afterDispatch: async result => { observed = JSON.parse(result.reply.text); return result; } }) },
    finalizeBensonHandledReply: registry.finalizeBensonHandledReply,
    markAgentRunExecutionCoverageUnknown: registry.markAgentRunExecutionCoverageUnknown,
  });
  await events.y(registry.d(), () => registry.withBensonNativeCompletion(f.params, async () => {
    const reply = await runHook({ runId: f.params.runId, trigger: 'user', context: {}, event: {} });
    assert.equal(observed.completion.outcome, 'FAILED');
    return { payloads: [reply.reply], meta: { finalAssistantRawText: reply.reply.text } };
  }));
});

nativeTest('missing trusted binding holds output instead of inventing a route; agent bindings never become authority', async () => {
  const f = await fixture(); f.attempt.settle(true);
  const fake = { ...f.proposal, binding: f.context.bensonCompletionEvidence.binding };
  delete f.context.bensonCompletionEvidence;
  assert.equal(events.s({ runId: f.params.runId, stream: 'assistant',
    data: { text: 'raw managed pre-boundary' } }), false);
  assert.equal(events.s({ runId: f.params.runId, stream: 'lifecycle',
    data: { phase: 'error' } }), false);
  await assert.rejects(registry.withBensonNativeCompletion(f.params, async () => f.result(fake)), { code: 'ERR_BENSON_COMPLETION_BLOCKED' });
  assert.equal(f.context.bensonCompletionBoundary.record, null);
});


nativeTest('ordinary handled reply retains native hook result without a Benson owner', async () => {
  const runId = 'r03-ordinary-handled-' + ++sequence;
  const result = { handled: true, reply: { text: 'ordinary hook result' } };
  registry._(runId, { agentId: 'ordinary-agent', sessionKey: 'ordinary:fixture',
    sessionId: 'ordinary-session' });
  assert.equal(registry.finalizeBensonHandledReply(runId, result), result);
  assert.equal(registry.c(runId).bensonCompletionBoundary, undefined);
});

nativeTest('provider schema hints cannot bypass deterministic finalization', async () => {
  for (const structuredOutput of [undefined, { type: 'json_schema' }]) {
    const f = await fixture(); f.attempt.settle(true); f.params.structuredOutput = structuredOutput;
    const result = await entry('embedded', async () => f.result('invalid'))(f.params);
    assert.equal(result.meta.bensonCompletion.completion.outcome, 'RECOVERED');
  }
});

nativeTest('real native CLI synthetic terminal is canonical before the actual observer runs', async () => {
  const f = await fixture('future-fixture'); f.attempt.settle(true); f.params.trigger = 'user';
  const hookOwner = await load('hook-runner-global-C81Znoo2.mjs');
  const empty = await load('registry-empty--vb91VWS.mjs');
  const observer = await load('auth-profile-failure-policy-BlqvJ9aj.mjs');
  const cli = await load('cli-runner-DQ-f1RtK.mjs');
  const hooks = empty.t();
  hooks.typedHooks.push({ pluginId: 'r03-fixture', hookName: 'before_agent_reply',
    handler: async () => ({ handled: true, reply: { text: 'RAW_SYNTHETIC_FIXTURE' } }) });
  hookOwner.i(hooks); let observed;
  try {
    const result = await observer.i({ beforeDispatch: async () => true,
      afterDispatch: async hook => { observed = JSON.parse(hook.reply.text); return hook; } }, () => cli.n(f.params));
    // An uninstrumented plugin hook cannot certify zero execution, even when
    // a previous attempt was fully covered. Known business facts remain intact.
    assert.equal(observed.completion.outcome, 'FAILED');
    assert.deepEqual(JSON.parse(result.payloads[0].text), plain(observed));
    assert.equal(result.meta.bensonCompletion.completion.outcome, 'FAILED');
    assert.equal(result.payloads[0].text.includes('RAW_SYNTHETIC_FIXTURE'), false);
  } finally { hookOwner.a(); }
});

nativeTest('real native CLI cancellation preserves the AbortError and trusted success', async () => {
  const f = await fixture('jessica-vacuum', { domain: true }); f.attempt.settle(true);
  const cli = await load('cli-runner-DQ-f1RtK.mjs');
  const controller = new AbortController(); const reason = new Error('fixture cancellation'); reason.name = 'AbortError';
  controller.abort(reason); f.params.abortSignal = controller.signal;
  await assert.rejects(cli.n(f.params), error => {
    assert.equal(error, reason); assert.equal(error.bensonCompletion.completion.outcome, 'RECOVERED');
    assert.equal(error.bensonCompletion.facts.status, 'success'); return true;
  });
});

nativeTest('real native embedded preparation failure cannot return raw terminal output', async () => {
  const f = await fixture(); f.attempt.settle(true);
  const embedded = await load('embedded-agent-BaH7wGBd.mjs');
  f.params.workspaceDir = process.env.OPENCLAW_STATE_DIR;
  f.params.agentDir = join(process.env.OPENCLAW_STATE_DIR, 'fixture-agent');
  f.params.sessionPersistence = 'detached'; f.params.sessionTarget = undefined;
  await assert.rejects(embedded.t(f.params), error => {
    assert.ok(error.bensonCompletion, error.message);
    assert.equal(error.bensonCompletion.completion.outcome, 'RECOVERED'); return true;
  });
});

nativeTest('actual failed/nested wrappers retain launches despite absent UI events', async () => {
  const f = await fixture(); let executions = 0;
  const make = (name, execute) => tools.u({ name, label: name, description: 'Fixture',
    hideFromChannelProgress: true, parameters: { type: 'object', properties: {} }, execute },
    { runId: f.params.runId, sessionKey: f.params.sessionKey, config: {} }, { emitDiagnostics: false });
  const child = make('r03_nested_child', async () => { executions++; throw new Error('fixture tool failure'); });
  const parent = make('r03_nested_parent', async () => { executions++; return child.execute('nested-child', {}); });
  await assert.rejects(parent.execute('nested-parent', {}), /fixture tool failure/u);
  const snapshot = f.attempt.settle(true);
  assert.equal(executions, 2); assert.equal(snapshot.executionCount, 2); assert.equal(snapshot.complete, true);
  assert.equal(f.context.executionEvidence.activeExecutions, 0);
});

nativeTest('native run replacement rejects old accepted records and captured terminal ownership', async () => {
  const f = await fixture(); f.attempt.settle(true);
  const owner = registry.beginBensonNativeCompletion(f.params);
  registry.finishBensonNativeCompletion(owner, f.result());
  const replacement = admission.a(f.params.runId); registry.i(replacement);
  assert.throws(() => registry.finishBensonNativeCompletion(owner, f.result()), { code: 'ERR_BENSON_COMPLETION_BLOCKED' });
  assert.equal(registry.permitBensonNativeTerminalEvent({ runId: f.params.runId, stream: 'lifecycle', data: { phase: 'end' } }), false);
});

nativeTest('new tool execution invalidates a previously accepted native terminal record', async () => {
  const f = await fixture(); f.attempt.settle(true);
  const owner = registry.beginBensonNativeCompletion(f.params); registry.finishBensonNativeCompletion(owner, f.result());
  const settle = registry.recordAgentRunToolExecution(f.params.runId);
  assert.equal(f.context.bensonCompletionBoundary.record, null);
  assert.equal(registry.permitBensonNativeTerminalEvent({ runId: f.params.runId, stream: 'lifecycle', data: { phase: 'end' } }), false);
  const result = registry.finishBensonNativeCompletion(owner, f.result());
  assert.equal(result.meta.bensonCompletion.completion.outcome, 'FAILED');
  settle();
});

nativeTest('native callback boundary blocks early terminal/prose block callbacks', async () => {
  const f = await fixture(); f.attempt.settle(true); registry.x(f.authority);
  const owner = registry.beginBensonNativeCompletion(f.params); const seen = [];
  const guarded = registry.guardBensonNativeAgentCallbacks({ ...f.params,
    onAgentEvent: event => seen.push(event), onBlockReply: payload => seen.push(payload) });
  guarded.onAgentEvent({ runId: f.params.runId, stream: 'assistant', data: { text: 'RAW_CALLBACK_FIXTURE' } });
  guarded.onAgentEvent({ runId: f.params.runId, stream: 'lifecycle', data: { phase: 'end' } });
  guarded.onBlockReply({ text: 'RAW_CALLBACK_FIXTURE' }); assert.equal(seen.length, 0);
  const result = registry.finishBensonNativeCompletion(owner, f.result());
  guarded.onAgentEvent({ runId: f.params.runId, stream: 'assistant', data: { text: 'RAW_CALLBACK_FIXTURE' } });
  guarded.onAgentEvent({ runId: f.params.runId, stream: 'lifecycle', data: { phase: 'end' } });
  guarded.onBlockReply({ text: 'RAW_CALLBACK_FIXTURE' }); assert.equal(seen.length, 2);
  assert.equal(seen[0].data.completionOutcome, 'NORMAL');
  assert.deepEqual(JSON.parse(seen[1].text), plain(result.meta.bensonCompletion));
});

nativeTest('executed or unaccounted native error is marked non-retryable by the native fallback owner', async () => {
  const fallback = await load('model-fallback-stop-B0RY23Zf.mjs');
  for (const coverage of [true, false]) {
    const f = await fixture('jessica-vacuum', { domain: true, coverage });
    if (coverage) registry.recordAgentRunToolExecution(f.params.runId)();
    f.attempt.settle(true); const error = new Error('fixture provider failure');
    await assert.rejects(registry.withBensonNativeCompletion(f.params, async () => { throw error; }), actual => {
      assert.equal(actual, error); assert.equal(fallback.t(actual), true); return true;
    });
  }
});

nativeTest('exported prepared CLI execution also inherits the native completion boundary', async () => {
  const f = await fixture(); f.attempt.settle(true);
  const prepared = nativeFunction('cli-runner-DQ-f1RtK.mjs', 'runPreparedCliAgent', {
    withAgentRunLifecycleGeneration: events.y, captureAgentRunLifecycleGeneration: () => registry.d(),
    withBensonNativeCompletion: registry.withBensonNativeCompletion,
    guardBensonNativeAgentCallbacks: registry.guardBensonNativeAgentCallbacks,
    isBensonNativeManagedRun: registry.isBensonNativeManagedRun,
    runPreparedCliAgentOwned: async () => f.result('plain prepared CLI answer'),
    runWithCliHistoryWriter: async (_writer, run) => run(),
  });
  const result = await prepared({ params: f.params });
  assert.equal(result.meta.bensonCompletion.completion.outcome, 'RECOVERED');
});


nativeTest('ordinary prepared CLI keeps original context, raw result and failure', async () => {
  const runId = 'r03-ordinary-prepared-cli-' + ++sequence;
  const params = { runId, agentId: 'ordinary-cli', sessionKey: 'agent:ordinary-cli:fixture',
    sessionId: 'ordinary-cli-session', lifecycleGeneration: registry.d() };
  registry._(runId, params);
  const context = { params, cliHistoryWriter: {} };
  const raw = { payloads: [{ text: 'ordinary prepared CLI final' }], meta: {} };
  const failure = new Error('ordinary prepared CLI failure');
  let next = () => raw;
  const seen = [];
  const prepared = nativeFunction('cli-runner-DQ-f1RtK.mjs', 'runPreparedCliAgent', {
    isBensonNativeManagedRun: registry.isBensonNativeManagedRun,
    withAgentRunLifecycleGeneration: () => { throw new Error('ordinary CLI entered Benson lifecycle'); },
    captureAgentRunLifecycleGeneration: () => { throw new Error('ordinary CLI captured Benson lifecycle'); },
    withBensonNativeCompletion: () => { throw new Error('ordinary CLI entered Benson gate'); },
    guardBensonNativeAgentCallbacks: () => { throw new Error('ordinary CLI guarded native callbacks'); },
    runPreparedCliAgentOwned: async actual => { assert.equal(actual, context); return next(); },
    runWithCliHistoryWriter: async (writer, run) => { assert.equal(writer, context.cliHistoryWriter);
      seen.push('history'); return run(); },
  });
  assert.equal(await prepared(context), raw);
  next = () => { throw failure; };
  await assert.rejects(prepared(context), error => error === failure);
  assert.deepEqual(seen, ['history', 'history']);
  assert.equal(registry.c(runId).bensonCompletionBoundary, undefined);
});

nativeTest('late native callbacks cannot reuse completion after run/session replacement', async () => {
  for (const replacement of ['run', 'session']) {
    const f = await fixture(); f.attempt.settle(true);
    const owner = registry.beginBensonNativeCompletion(f.params); registry.finishBensonNativeCompletion(owner, f.result());
    let calls = 0; const guarded = registry.guardBensonNativeAgentCallbacks({ ...f.params,
      onAgentEvent: () => calls++, onBlockReply: () => calls++ });
    if (replacement === 'run') registry.i(admission.a(f.params.runId));
    else f.context.sessionId = 'replacement-session';
    guarded.onAgentEvent({ runId: f.params.runId, stream: 'lifecycle', data: { phase: 'end' } });
    guarded.onBlockReply({ text: 'late output' }); assert.equal(calls, 0);
  }
});

nativeTest('frozen native errors and primitive failures still retain canonical runtime completion', async () => {
  for (const error of [Object.freeze(new Error('frozen fixture error')), 'primitive fixture failure']) {
    const f = await fixture(); f.attempt.settle(true);
    await assert.rejects(registry.withBensonNativeCompletion(f.params, async () => { throw error; }), actual => {
      if (error instanceof Error) assert.equal(actual, error);
      else { assert.ok(actual instanceof Error); assert.equal(actual.message.includes(error), false); }
      assert.equal(f.context.bensonCompletionBoundary.record.completion.outcome, 'RECOVERED'); return true;
    });
  }
});

nativeTest('nested native completion boundaries preserve the original terminal error without replay', async () => {
  const f = await fixture('jessica-vacuum', { domain: true }); f.attempt.settle(true);
  const error = new Error('nested fixture error'); let calls = 0;
  await assert.rejects(registry.withBensonNativeCompletion(f.params, () =>
    registry.withBensonNativeCompletion(f.params, async () => { calls++; throw error; })), actual => {
      assert.equal(actual, error); assert.equal(actual.bensonCompletion.completion.outcome, 'RECOVERED'); return true;
    });
  assert.equal(calls, 1);
});

nativeTest('actual native coverage classifier fails closed for every registered extension and changed catalog', async () => {
  const metadata = await load('registry-empty--vb91VWS.mjs'); const empty = metadata.t();
  let active = empty; let version = 2;
  const coverage = nativeFunction('selection-WkHO-qmO.mjs', 'hasCompleteNativeExecutionCoverage', {
    getActivePluginRegistry: () => active, getActivePluginRegistryVersion: () => version,
    pluginArrays: metadata.n, pluginMaps: metadata.r, Map,
  });
  const check = (params = {}, selection = { builtIn: true }) => coverage(selection, params, empty, 2);
  assert.equal(check(), true);
  for (const key of metadata.n) { empty[key].push({ fixture: true }); assert.equal(check(), false, key); empty[key].pop(); }
  for (const key of metadata.r) { empty[key].set('fixture', {}); assert.equal(check(), false, key); empty[key].delete('fixture'); }
  empty.contextEngines.set('fixture', {}); assert.equal(check(), false); empty.contextEngines.clear();
  empty.compactionProviders.push({}); assert.equal(check(), false); empty.compactionProviders.pop();
  assert.equal(check({ clientTools: [{}] }), false); assert.equal(check({ contextEngine: {} }), false);
  assert.equal(check({}, { builtIn: false }), false);
  version++; assert.equal(check(), false); version = 2; active = metadata.t(); assert.equal(check(), false);
});

nativeTest('native pre-execution abort does not count a tool launch or fabricate zero from UI silence', async () => {
  const f = await fixture(); let executions = 0;
  const wrapped = tools.u({ name: 'r03_prelaunch_fixture', label: 'Fixture', description: 'Fixture',
    parameters: { type: 'object', properties: {} }, execute: async () => { executions++; return {}; } },
    { runId: f.params.runId, sessionKey: f.params.sessionKey, config: {} }, { emitDiagnostics: false });
  const controller = new AbortController(); controller.abort(new Error('fixture prelaunch abort'));
  await assert.rejects(wrapped.execute('aborted-fixture', {}, controller.signal));
  const snapshot = f.attempt.settle(true);
  assert.equal(executions, 0); assert.equal(snapshot.executionCount, 0); assert.equal(snapshot.complete, true);
});

nativeTest('missing native admission cannot run the agent or release its plain terminal result', async () => {
  for (const kind of ['embedded', 'cli']) {
    let calls = 0; const f = await fixture(); delete f.params.preparedRunAdmission;
    await assert.rejects(entry(kind, async () => { calls++; return f.result('plain'); })(f.params), { code: 'ERR_BENSON_COMPLETION_BLOCKED' });
    assert.equal(calls, 0);
  }
});

nativeTest('child native execution identity is fenced independently of the trusted caller workflow session', async () => {
  const f = await fixture('jessica-vacuum', { domain: true }); f.attempt.settle(true);
  assert.notEqual(f.context.bensonCompletionEvidence.binding.sessionId, f.context.sessionId);
  assert.notEqual(f.context.bensonCompletionEvidence.binding.sessionKey, f.context.sessionKey);
  const result = await entry('embedded', async () => f.result())(f.params);
  assert.equal(result.meta.bensonCompletion.completion.outcome, 'NORMAL');
  assert.equal(result.meta.bensonCompletion.binding.sessionKey, 'agent:main:r03-caller');
  assert.equal(result.meta.bensonCompletion.binding.instanceId, f.admitted.operationalRunInstance.instanceId);
  assert.equal(registry.permitBensonNativeTerminalEvent({ runId: f.params.runId, stream: 'lifecycle', data: { phase: 'end' } }), true);
  f.context.sessionId = 'replacement-child-execution-session';
  assert.throws(() => registry.finishBensonNativeCompletion({ context: f.context, boundary: f.context.bensonCompletionBoundary, runId: f.params.runId }, f.result()), { code: 'ERR_BENSON_COMPLETION_BLOCKED' });
  assert.equal(registry.permitBensonNativeTerminalEvent({ runId: f.params.runId, stream: 'lifecycle', data: { phase: 'end' } }), false);
});

nativeTest('nested native event lifecycle scopes preserve immutable completion ownership', async () => {
  const f = await fixture(); f.attempt.settle(true);
  await events.y(registry.d(), () => registry.withBensonNativeCompletion(f.params, async () => {
    const owner = registry.M().getStore().bensonRunOwnership;
    await events.y(registry.d(), async () => {
      assert.equal(registry.M().getStore().bensonRunOwnership, owner);
      assert.equal(registry.permitBensonNativeTerminalEvent({ runId: f.params.runId, stream: 'lifecycle', data: { phase: 'end' } }), false);
    });
    return f.result();
  }));
});

nativeTest('native lifecycle rotation invalidates retained finalization owner', async () => {
  const f = await fixture(); f.attempt.settle(true);
  const owner = registry.beginBensonNativeCompletion(f.params);
  registry.E(); assert.equal(registry.O(f.authority), false);
  assert.throws(() => registry.finishBensonNativeCompletion(owner, f.result()), { code: 'ERR_BENSON_COMPLETION_BLOCKED' });
});

nativeTest('ACP native admission cannot persist, publish, or deliver raw terminal output', async () => {
  const source = readFileSync(join(root, 'dist', 'agent-command-Dyd2gex-.mjs'), 'utf8');
  assert.match(source, /return await withBensonNativeCompletion\([^\n]+runAcpAgentCommand\(/u);
  for (const failureName of [null, 'Error', 'TimeoutError', 'AbortError']) {
    const f = await fixture();
    const writes = []; const eventsSeen = []; const liveAssistant = []; let text = '';
    const offAssistant = events.f(event => {
      if (event.runId === f.params.runId && event.stream === 'assistant') liveAssistant.push(event);
    });
    const runtime = {
      createAcpToolLifecycleTracker: () => ({}), emitAcpLifecycleStart: () => {},
      createAcpVisibleTextAccumulator: () => {
        let value = '';
        return { consume: chunk => { value += chunk; return { text: value, delta: chunk }; },
          finalize: () => value.trim(), finalizeRaw: () => value,
          finalizeReplySnapshot: () => ({ disposition: 'visible', text: value }) };
      },
      emitAcpRuntimeEvent: () => {}, emitAcpAssistantDelta: params => {
        assert.equal(events.s({ runId: params.runId, stream: 'assistant',
          data: { text: params.text, delta: params.delta } }), false);
      },
      resolveAcpLifecycleEndFields: () => ({}),
      buildAcpResult: params => ({ payloads: [{ text: params.payloadText }], meta: { terminalReply: params.terminalReply } }),
      persistAcpTurnTranscript: async params => {
        assert.ok(f.context.bensonCompletionBoundary.record);
        writes.push(['transcript', params.finalText]); return { sessionEntry: {} };
      },
      emitAcpLifecycleEnd: params => {
        assert.ok(f.context.bensonCompletionBoundary.record);
        writes.push(['terminal', params.terminalReply.text]);
      },
      emitAcpLifecycleError: () => {
        assert.ok(f.context.bensonCompletionBoundary.record);
        eventsSeen.push('error');
      }
    };
    const acp = nativeFunction('agent-command-Dyd2gex-.mjs', 'runAcpAgentCommand', {
      Date, Error, getInstallationTarget: () => undefined,
      loadAttemptExecutionRuntime: async () => runtime,
      isSubagentCoordinationInputProvenance: () => false,
      registerAgentRunContext: registry._,
      loadAcpPolicyRuntime: async () => ({ resolveAcpDispatchPolicyError: () => undefined,
        resolveAcpAgentPolicyError: () => undefined }),
      normalizeAgentId: value => value, resolveInlineAgentImageAttachments: () => [],
      assertAgentRunLifecycleGenerationCurrent: () => {},
      createLazyAcpElicitationHandler: () => undefined,
      getAdmittedRunDelegatedAuthority: () => f.authority,
      isAgentRunRestartAbortReason: () => false,
      loadAcpRuntimeErrorsRuntime: async () => ({ toAcpRuntimeError: ({ error }) => error }),
      loadAcpSessionIdentifiersRuntime: async () => ({ resolveAcpSessionCwd: () => undefined }),
      buildAgentRunTerminalOutcomeFromLifecycleEvent: () => ({}),
      applyAgentRunAbortMetadata: value => value,
      loadDeliveryRuntime: async () => ({ deliverAgentCommandResult: async params => {
        assert.ok(f.context.bensonCompletionBoundary.record);
        writes.push(['delivery', params.payloads[0].text]); return params.result;
      } }),
      classifyAgentRunTerminalOutcome: () => 'success', recordAgentRunTerminalOutcome: value => value,
      beginAgentRunExecutionEvidence: registry.beginAgentRunExecutionEvidence,
      finishBensonNativeCompletion: registry.finishBensonNativeCompletion,
      getAgentEventExecutionContext: registry.M
    });
    const preparedRunAdmission = { operationalRunInstance: f.admitted.operationalRunInstance,
      admit: async () => f.admitted };
    const params = { ...f.params, sessionAgentId: 'main', preparedRunAdmission,
      opts: {}, cfg: {}, acpResolution: { meta: { agent: 'main' } },
      trackInternalModelRunTarget: () => {},
      acpManager: { runTurn: async callbacks => {
        text = 'RAW_ACP_FINAL';
        callbacks.onEvent({ type: 'text_delta', text });
        if (failureName) { const error = new Error('fixture ACP failure'); error.name = failureName; throw error; }
        callbacks.onEvent({ type: 'done', status: 'success', stopReason: 'end_turn' });
      } } };
    const run = () => registry.withBensonNativeCompletion({ ...params, agentId: 'main' }, () => acp(params));
    if (failureName) {
      await assert.rejects(run(), error => {
        assert.equal(error.name, failureName);
        assert.equal(error.bensonCompletion.completion.outcome, 'FAILED'); return true;
      });
      assert.deepEqual(eventsSeen, ['error']); assert.deepEqual(writes, []);
    } else {
      const result = await run();
      assert.equal(result.meta.bensonCompletion.completion.outcome, 'FAILED');
      assert.equal(f.context.executionEvidence.complete, false);
      assert.deepEqual(writes.map(([kind]) => kind), ['transcript', 'terminal', 'delivery']);
      for (const [, value] of writes) {
        assert.deepEqual(JSON.parse(value), plain(result.meta.bensonCompletion));
        assert.equal(value.includes(text), false);
      }
      assert.equal(result.meta.terminalReply.text.includes(text), false);
      assert.deepEqual(JSON.parse(result.payloads[0].text), plain(result.meta.bensonCompletion));
    }
    assert.equal(liveAssistant.length, 0, 'raw ACP text reached the user-visible event bus');
    offAssistant();
    f.attempt.settle(true);
  }
});


nativeTest('ordinary ACP preserves native streaming, transcript, result ordering and error', async () => {
  for (const failed of [false, true]) {
    const runId = 'r03-ordinary-acp-' + ++sequence;
    const params = { runId, agentId: 'ordinary-acp', sessionAgentId: 'ordinary-acp',
      sessionKey: 'agent:ordinary-acp:fixture', sessionId: 'ordinary-acp-session',
      lifecycleGeneration: registry.d(), opts: {}, cfg: {},
      acpResolution: { meta: { agent: 'ordinary-acp' } }, trackInternalModelRunTarget: () => {} };
    registry._(runId, params);
    params.preparedRunAdmission = admission.l({}, runId, params.agentId, 'ordinary.acp');
    const admitted = await params.preparedRunAdmission.admit('acp');
    const observed = [];
    const raw = 'RAW_ORDINARY_ACP';
    const failure = new Error('ordinary ACP failure');
    const runtime = {
      createAcpToolLifecycleTracker: () => ({}), emitAcpLifecycleStart: () => {},
      createAcpVisibleTextAccumulator: () => {
        let value = '';
        return { consume: chunk => { value += chunk; return { text: value, delta: chunk }; },
          finalize: () => value.trim(), finalizeRaw: () => value,
          finalizeReplySnapshot: () => ({ disposition: 'visible', text: value }) };
      },
      emitAcpRuntimeEvent: () => {},
      emitAcpAssistantDelta: value => {
        assert.equal(events.s({ runId, stream: 'assistant',
          data: { text: value.text, delta: value.delta } }), true);
        observed.push('delta');
      },
      resolveAcpLifecycleEndFields: () => ({}),
      buildAcpResult: value => {
        observed.push('build');
        return { payloads: [{ text: value.payloadText }],
          meta: { finalAssistantRawText: value.payloadText, terminalReply: value.terminalReply } };
      },
      persistAcpTurnTranscript: async value => {
        assert.equal(value.finalText, raw);
        observed.push('transcript'); return { sessionEntry: {} };
      },
      emitAcpLifecycleEnd: value => {
        assert.equal(value.terminalReply.text, raw);
        observed.push('end');
      },
      emitAcpLifecycleError: () => observed.push('error')
    };
    const acp = nativeFunction('agent-command-Dyd2gex-.mjs', 'runAcpAgentCommand', {
      Date, Error, getInstallationTarget: () => undefined,
      loadAttemptExecutionRuntime: async () => runtime,
      isSubagentCoordinationInputProvenance: () => false,
      registerAgentRunContext: registry._,
      loadAcpPolicyRuntime: async () => ({ resolveAcpDispatchPolicyError: () => undefined,
        resolveAcpAgentPolicyError: () => undefined }),
      normalizeAgentId: value => value, resolveInlineAgentImageAttachments: () => [],
      assertAgentRunLifecycleGenerationCurrent: () => {},
      createLazyAcpElicitationHandler: () => undefined,
      getAdmittedRunDelegatedAuthority: () => registry.s(admitted.operationalRunInstance),
      isAgentRunRestartAbortReason: () => false,
      loadAcpRuntimeErrorsRuntime: async () => ({ toAcpRuntimeError: ({ error }) => error }),
      loadAcpSessionIdentifiersRuntime: async () => ({ resolveAcpSessionCwd: () => undefined }),
      buildAgentRunTerminalOutcomeFromLifecycleEvent: () => ({}),
      applyAgentRunAbortMetadata: value => value,
      loadDeliveryRuntime: async () => ({ deliverAgentCommandResult: async value => {
        observed.push('delivery'); return value.result;
      } }),
      classifyAgentRunTerminalOutcome: () => 'success', recordAgentRunTerminalOutcome: value => value,
      beginAgentRunExecutionEvidence: registry.beginAgentRunExecutionEvidence,
      finishBensonNativeCompletion: registry.finishBensonNativeCompletion,
      getAgentEventExecutionContext: registry.M
    });
    params.acpManager = { runTurn: async callbacks => {
      callbacks.onEvent({ type: 'text_delta', text: raw });
      if (failed) throw failure;
      callbacks.onEvent({ type: 'done', status: 'success', stopReason: 'end_turn' });
    } };
    const run = () => events.y(registry.d(), () => registry.withBensonNativeCompletion(params, () => acp(params)));
    if (failed) {
      await assert.rejects(run(), error => error === failure);
      assert.deepEqual(observed, ['delta', 'error']);
    } else {
      const result = await run();
      assert.equal(result.payloads[0].text, raw);
      assert.equal(result.meta.bensonCompletion, undefined);
      assert.deepEqual(observed, ['delta', 'transcript', 'end', 'build', 'delivery']);
    }
    assert.equal(registry.c(runId).bensonCompletionBoundary, undefined);
  }
});

nativeTest('native writer supersession cancels before a deferred canonical terminal is published', async () => {
  const f = await fixture(); const seen = []; const off = events.f(event => seen.push(event));
  try {
    registry.beginBensonNativeCompletion(f.params);
    let cancelled = 0;
    const supersede = nativeFunction('runs-BGbFdTuu.mjs', 'supersedeEmbeddedAgentRunByRunId', {
      ACTIVE_EMBEDDED_RUNS_BY_RUN_ID: new Map([[f.params.runId, { cancel: () => { cancelled++; } }]]),
      isEmbeddedRunHandleSupersedable: () => true,
      supersedeReplyRunByRunId: () => { throw new Error('wrong native run owner'); }
    });
    const claim = nativeFunction('embedded-agent-BaH7wGBd.mjs', 'claimAgentSessionWriter', {
      assertAgentHarnessRunAdmission: () => ({ entry: { sessionId: f.params.sessionId,
        lifecycleRevision: 1, activeWriterRunId: f.params.runId },
        sessionKey: f.params.sessionKey, agentId: 'main' }),
      normalizeOptionalString: value => value,
      updateSessionEntry: async (_target, update) => update({ sessionId: f.params.sessionId,
        lifecycleRevision: 1, activeWriterRunId: f.params.runId }),
      supersedeEmbeddedAgentRunByRunId: supersede,
      getAgentRunContext: registry.c, emitAgentEventIfCurrent: events.s,
      log$3: { warn: () => {} }, sanitizeForLog: value => value,
      redactRunIdentifier: value => value
    });
    await claim({ runId: 'successor-writer', sessionId: f.params.sessionId });
    assert.equal(cancelled, 1); assert.equal(seen.length, 0);
    f.attempt.settle(true);
    const error = new Error('native cancellation'); error.name = 'AbortError';
    await assert.rejects(registry.withBensonNativeCompletion(f.params, async () => { throw error; }), actual => {
      assert.equal(actual, error); assert.equal(actual.bensonCompletion.completion.outcome, 'RECOVERED'); return true;
    });
    assert.equal(events.s({ runId: f.params.runId, stream: 'lifecycle',
      data: { phase: 'error', aborted: true, endedAt: Date.now() } }), true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].data.completionOutcome, 'RECOVERED');
  } finally { off(); }
});

nativeTest('embedded native error catch finalizes before settlement and emits exactly one canonical terminal', async () => {
  const f = await fixture(); f.attempt.settle(true);
  const source = readFileSync(join(root, 'dist', 'embedded-agent-BaH7wGBd.mjs'), 'utf8');
  const nativeCatch = source.match(/\} catch \(error\) \{\n\t{4}finishBensonNativeCompletion[^]*?\n\t{3}\}/u)?.[0];
  assert.ok(nativeCatch, 'native error catch must finalize before settling or emitting');
  const observed = []; const off = events.f(event => observed.push(event));
  try {
    const terminal = { emit: (phase, error) => events.s({ runId: f.params.runId,
      stream: 'lifecycle', data: { phase, error: error.message, endedAt: Date.now() } }) };
    const failure = new Error('fixture embedded failure');
    const nativeFailure = new vm.Script(`(async (error) => { try { throw error; ${nativeCatch} })`).runInNewContext({
      params: {}, terminal,
      getAgentEventExecutionContext: registry.M,
      finishBensonNativeCompletion: registry.finishBensonNativeCompletion,
      settleFailedRequesterRun: (_params, error) => {
        assert.ok(f.context.bensonCompletionBoundary.record, 'settlement preceded canonical completion');
        return error;
      },
      resolveSessionPlacementTurnSettlementAssertion: () => () => {}
    });
    await assert.rejects(registry.withBensonNativeCompletion(f.params, () => nativeFailure(failure)), actual => {
      assert.equal(actual, failure);
      assert.equal(actual.bensonCompletion.completion.outcome, 'RECOVERED'); return true;
    });
    assert.equal(observed.length, 1);
    assert.equal(observed[0].data.phase, 'error');
    assert.equal(observed[0].data.completionOutcome, 'RECOVERED');
  } finally { off(); }
});
