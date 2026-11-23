import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { plain } from '../../../benson-routing/core/value.js';
import type { OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import { createJessicaTaskToolFactory, createJessicaReadToolFactory, resolveJessicaRequesterDelegation } from '../src/tool.js';
import { fixture as domainFixture } from './fixtures/domain-state.js';
import { Compile } from 'typebox/compile';
import { loadPolicy } from '../../../../../agents/jessica-vacuum/lib/policy.js';
import { validateResult } from '../../../../../agents/jessica-vacuum/lib/results.js';
import { validateDomainResult, readDomainFactsData } from '../../../benson-routing/core/domain-result.js';
import { createJessicaExecuteToolFactory } from '../src/execute-tool.js';
import { createCompletionAuthority, acceptAgentCompletion } from '../../../benson-routing/core/completion.js';
import { normalizeLegacyTaskResult } from '../../../benson-routing/core/legacy-response.js';
import { executeJessicaRoomTask } from '../../../../../agents/jessica-vacuum/lib/task.js';
import { createJessicaExecutor } from '../../../../../agents/jessica-vacuum/lib/executor.js';
import { ingressInputId, ingressTextHash, type NativeCurrentInputEvidence, type CurrentRequestEvidence, type ConversationCutoff } from '../../../benson-routing/core/conversation-context.js';
import { renderJessicaDomainResult } from '../../../../../agents/jessica-vacuum/lib/presentation.js';
import { createMainResponseDelivery } from '../../../benson-routing/core/response-control.js';
import { createResponseV4Envelope } from '../../../benson-routing/core/legacy-response.js';

function roomActionFixture() {
  const f = domainFixture(); let effects = 0, live = true, unknown = false, mismatch = false;
  let beforeMutation = () => {}, afterDispatch = () => {};
  const source: { -readonly [K in keyof CurrentRequestEvidence]: CurrentRequestEvidence[K] } & { cutoff: ConversationCutoff } = {
    request: 'Clean the living room',
    binding: { conversationRef: 'original-conversation', channel: 'whatsapp', accountId: 'fixture-account', kind: 'direct',
      peerId: 'tal-route', threadId: null, requesterId: 'tal-route' },
    cutoff: { sessionId: 'original-session', generation: 'original-generation', entryId: 'original-input', effectiveParentId: null },
    currentTurn() { return { entryId: this.cutoff.entryId, role: 'user', text: this.request,
      sender: { source: 'canonical_peer_binding', id: 'tal-route', channel: 'whatsapp', accountId: 'fixture-account' },
      inputProvenance: { kind: 'external_user' } }; },
    assertCurrent() { assert(live, 'source retired'); f.authority.assertCurrent(); },
    assertAuthorized() { assert(live, 'source unauthorized'); },
  };
  const executor = createJessicaExecutor({ registryConfig: f.registry, policyConfig: f.policy, store: f.store,
    clock: f.clock, wait: async () => {}, pollCounts: { clean: 1 },
    driver: { async read() { const evidence = structuredClone(f.evidence); evidence.status.observedAt = f.clock().toISOString(); return evidence; },
      async dispatch(step, guard) {
        beforeMutation(); await guard.assertMutationCurrent(); guard.assertCurrent();
        assert.equal(step.kind, 'command'); effects++; f.tick();
        if (!unknown) {
          const at = f.clock().toISOString();
          f.evidence.status = { observedAt: at, sourceUpdatedAt: at, state: 'cleaning', activeSegments: [mismatch ? 999 : f.room.segmentId], currentSegment: null };
          f.evidence.taskStatus = { observedAt: at, sourceUpdatedAt: at, state: 'room_cleaning' };
        }
        afterDispatch();
        if (unknown) throw new Error('fixture transport outcome unknown');
        return { accepted: true };
      } } });
  const deps = { source, executor, registryConfig: f.registry, policyConfig: f.policy, clock: f.clock, authority: f.authority,
    roster: { accountId: 'fixture-account', approvedIds: [...new Set(loadPolicy(f.policy).rules.map(rule => rule.subject))],
      subjectForRoute: (route: string) => route === 'tal-route' ? 'tal' : null } };
  return { ...f, source, deps, executor, effects: () => effects, retire: () => { live = false; },
    unknown: () => { unknown = true; }, mismatch: () => { mismatch = true; },
    beforeMutation: (fn: () => void) => { beforeMutation = fn; }, afterDispatch: (fn: () => void) => { afterDispatch = fn; },
    run: (request: unknown = { kind: 'benson.self-contained-request', version: 1, request: source.request }) => executeJessicaRoomTask(request, deps) };
}
test('source-bound room action: Tal original input to verified start and Response preparation without a Run or send', async () => {
  const f = roomActionFixture(), result = validateDomainResult(await f.run());
  assert.equal(result.executionMode, 'deterministic'); assert.equal(result.outcome.status, 'success');
  assert.deepEqual(result.facts.verificationScope, ['room_cleaning_start']);
  assert.equal(result.effects.status, 'known'); assert.equal(result.effects.reconciliation.required, false);
  assert.equal(result.content?.state, 'usable');
  assert(result.content?.state === 'usable'); assert.equal(result.content.text, 'הניקוי בחדר שביקשת התחיל.');
  assert(plain(result.facts.data) && typeof result.facts.data.operationId === 'string');
  const retained = await f.executor.state.correlation(result.facts.data.operationId); assert(retained);
  assert.equal(retained.owner.requesterId, 'tal'); assert.equal(retained.owner.requestEpoch, 'original-input');
  assert.deepEqual(retained.origin, { binding: f.source.binding, cutoff: f.source.cutoff });
  assert.equal(retained.plan.rooms[0]?.slug, 'living_room'); assert.equal(retained.plan.settings, null);
  assert(await f.executor.state.resource().then(resource => resource.owner !== null));
  assert.equal(f.effects(), 1); assert.deepEqual(await f.run(), result); assert.equal(f.effects(), 1);
  // The fixture injects only an inert device adapter. No Run/LLM/delivery port exists.
  assert.equal(result.pendingContext, null); assert.equal(result.operation, 'clean');
});
test('source-bound room action: Hebrew command resolves only an exact accepted alias', async () => {
  const f = roomActionFixture(); f.source.request = 'נקה את הסלון';
  const result = await f.run(); assert.equal(result.outcome.status, 'success');
  assert(plain(result.facts.data)); assert.deepEqual(result.facts.data.rooms, ['living_room']); assert.equal(f.effects(), 1);
});
for (const fault of ['forged-request', 'unsupported', 'multiple-rooms', 'settings', 'pending', 'foreign-route', 'wrong-cutoff',
  'cutoff-replaced', 'source-retired', 'request-replaced', 'cancelled', 'after-effect-retired', 'unknown-dispatch', 'wrong-segment'] as const) {
  test(`source-bound room action: fail closed ${fault}`, async () => {
    const f = roomActionFixture();
    const task = { kind: 'benson.self-contained-request', version: 1, request: f.source.request };
    if (fault === 'forged-request') task.request = 'Clean the hallway';
    if (fault === 'unsupported') f.source.request = 'Start a home cleaning';
    if (fault === 'multiple-rooms') f.source.request = 'Clean the living room and hallway';
    if (fault === 'settings') f.source.request = 'Clean the living room with turbo suction';
    if (fault === 'foreign-route') f.source.binding.peerId = 'foreign-route';
    if (fault === 'wrong-cutoff') f.source.currentTurn = () => ({ entryId: 'foreign-input', role: 'user', text: f.source.request,
      sender: { source: 'canonical_peer_binding', id: 'tal-route', channel: 'whatsapp', accountId: 'fixture-account' }, inputProvenance: { kind: 'external_user' } });
    if (fault === 'cutoff-replaced') f.beforeMutation(() => { f.source.cutoff.generation = 'replacement'; });
    if (fault === 'source-retired') f.beforeMutation(f.retire);
    if (fault === 'request-replaced') f.beforeMutation(() => { f.source.request = 'Clean the hallway'; });
    if (fault === 'cancelled') f.beforeMutation(() => { f.abort.abort(); });
    if (fault === 'after-effect-retired') f.afterDispatch(f.retire);
    if (fault === 'unknown-dispatch') f.unknown();
    if (fault === 'wrong-segment') f.mismatch();
    const execute = () => fault === 'pending' ? f.run({ ...task, version: 2, pending: { schemaVersion: 1, domain: 'jessica-vacuum',
      binding: { requesterId: 'tal-route', conversationId: 'original-conversation' }, clarificationId: 'prior' } }) :
      fault === 'forged-request' ? f.run(task) : f.run();
    if (fault === 'unknown-dispatch' || fault === 'wrong-segment') {
      const result = validateDomainResult(await execute());
      assert.notEqual(result.outcome.status, 'success'); assert.notEqual(result.facts.verified, true);
      assert.equal(result.effects.status, 'possible'); assert.equal(result.effects.reconciliation.required, true);
      assert.equal(result.outcome.disposition, 'unresolved'); assert.equal(f.effects(), 1);
      const duplicate = await execute(); assert.notEqual(duplicate.outcome.status, 'success'); assert.equal(f.effects(), 1);
    } else { await assert.rejects(execute); assert.equal(f.effects(), fault === 'after-effect-retired' ? 1 : 0); }
  });
}

function nativeRoomActionFixture() {
  const f = roomActionFixture();
  const state = { live: true, sources: 0, reads: 0, retireOnSerialize: false,
    records: [] as ReturnType<typeof validateDomainResult>[], guards: [] as (() => void)[] };
  const context: OpenClawPluginToolContext<2> = { agentId: 'main', sessionKey: f.source.binding.conversationRef,
    sessionId: f.source.cutoff.sessionId, requesterSenderId: 'tal-route',
    deliveryContext: { channel: 'whatsapp', accountId: 'fixture-account', to: 'tal-route' },
    assertInvocationCurrent() { assert(state.live, 'native invocation retired'); } };
  const options = { roster: f.deps.roster, policy: loadPolicy(f.policy), clock: f.clock,
    async read() { state.reads++; throw new Error('No read fallback in the room action assembly'); },
    roomAction: { registryConfig: f.registry, executor: f.executor,
      async source() { state.sources++; return f.source; } },
    jsonResult(value: Parameters<Parameters<typeof createJessicaTaskToolFactory>[0]['jsonResult']>[0], _callId: string,
      assertCurrent?: () => void) {
      assert(assertCurrent); assertCurrent();
      const result = validateDomainResult(value); state.records.push(result); state.guards.push(assertCurrent);
      if (state.retireOnSerialize) state.live = false;
      return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value };
    } };
  const make = () => { const tool = createJessicaTaskToolFactory(options)(context); assert(tool && !Array.isArray(tool)); return tool; };
  const tool = make();
  const run = (selected = tool) => selected.execute('native-action-call',
    { kind: 'benson.self-contained-request', version: 1, request: f.source.request }, f.abort.signal, undefined);
  return { ...f, state, context, options, make, tool, run };
}

test('native room action: Tal input through existing factory, executor and retained Response preparation; no Run/send', async () => {
  const f = nativeRoomActionFixture(); const serialized = await f.run();
  const result = validateDomainResult(serialized.details);
  assert(f.tool.outputSchema);
  assert.equal(Compile(f.tool.outputSchema).Check(result), true);
  assert.equal(result.operation, 'clean'); assert.equal(result.executionMode, 'deterministic');
  assert.equal(result.outcome.status, 'success'); assert.deepEqual(result.facts.verificationScope, ['room_cleaning_start']);
  assert.equal(result.content?.state === 'usable' ? result.content.text : '', 'הניקוי בחדר שביקשת התחיל.');
  assert.equal(f.state.records.length, 1); f.state.guards[0]!();
  assert.equal(f.state.reads, 0); assert.equal(f.effects(), 1);
  assert(plain(result.facts.data) && typeof result.facts.data.operationId === 'string');
  const owned = await f.executor.state.correlation(result.facts.data.operationId); assert(owned);
  assert.deepEqual(owned.origin, { binding: f.source.binding, cutoff: f.source.cutoff });
  assert.equal(owned.owner.requesterId, 'tal'); assert.equal(owned.plan.settings, null);
  assert.equal((await f.executor.state.resource()).owner?.operationId, result.facts.data.operationId);
  await assert.rejects(() => f.run(), /already_started/);
  const reconstructed = validateDomainResult((await f.run(f.make())).details);
  assert.deepEqual(reconstructed, result); assert.equal(f.effects(), 1);
  f.source.cutoff.generation = 'replacement'; assert.throws(f.state.guards[0]!);
});

for (const fault of ['foreign-caller', 'foreign-route', 'missing-cutoff', 'source-retired', 'cancelled', 'permission-denied',
  'caller-changed-before-effect', 'retired-after-effect', 'unknown-dispatch', 'retired-at-serialization', 'unsupported', 'settings'] as const) {
  test(`native room action: fail closed ${fault}`, async () => {
    const f = nativeRoomActionFixture();
    if (fault === 'foreign-caller') f.context.sessionId = 'foreign-session';
    if (fault === 'foreign-route') f.context.requesterSenderId = 'foreign-route';
    if (fault === 'missing-cutoff') Reflect.deleteProperty(f.source, 'cutoff');
    if (fault === 'source-retired') f.retire();
    if (fault === 'cancelled') f.abort.abort();
    if (fault === 'permission-denied') f.options.policy = loadPolicy({ ...f.options.policy,
      rules: f.options.policy.rules.map(rule => rule.subject === 'tal' && rule.actionClass === 'control' ? { ...rule, decision: 'deny' } : rule) });
    if (fault === 'caller-changed-before-effect') f.beforeMutation(() => { f.context.sessionKey = 'replaced-session'; });
    if (fault === 'retired-after-effect') f.afterDispatch(() => { f.state.live = false; });
    if (fault === 'unknown-dispatch') f.unknown();
    if (fault === 'retired-at-serialization') f.state.retireOnSerialize = true;
    if (fault === 'unsupported') f.source.request = 'Clean the living room and hallway';
    if (fault === 'settings') f.source.request = 'Clean the living room with turbo suction';
    // Reconstruct to apply any host policy change before construction.
    if (fault === 'permission-denied') { assert.throws(f.make, /policy.*roster/i); assert.equal(f.effects(), 0); return; }
    const tool = f.make();
    if (fault === 'unknown-dispatch') {
      const result = validateDomainResult((await f.run(tool)).details);
      assert.notEqual(result.outcome.status, 'success'); assert.equal(result.facts.verified, false);
      assert.equal(result.effects.status, 'possible'); assert.equal(result.effects.reconciliation.required, true);
      assert.equal(result.outcome.disposition, 'unresolved'); f.state.guards[0]!();
      await f.run(f.make()); assert.equal(f.effects(), 1);
    } else {
      await assert.rejects(() => f.run(tool));
      assert.equal(f.effects(), fault === 'retired-after-effect' || fault === 'retired-at-serialization' ? 1 : 0);
      for (const guard of f.state.guards) assert.throws(guard);
    }
    assert.equal(f.state.reads, 0);
  });
}

test('native room action: existing reasoning assembly coexists without shadowing exact room actions', async () => {
  const f = nativeRoomActionFixture(); let runs = 0;
  const tool = createJessicaTaskToolFactory({ ...f.options, task: { source: () => f.source,
    async run() { runs++; throw new Error('No Run permitted for this exact action'); } } })(f.context);
  assert(tool && !Array.isArray(tool));
  const result = await f.run(tool); assert.equal(result.details && typeof result.details === 'object' && 'operation' in result.details ? result.details.operation : null, 'clean');
  assert.equal(runs, 0); assert.equal(f.effects(), 1);
});

function nativeActionResponse(f: ReturnType<typeof nativeRoomActionFixture>, result: ReturnType<typeof validateDomainResult>) {
  const current = f.state.guards[0]!;
  return createMainResponseDelivery({ mode: 'native-resolver', requestId: 'original-input', agentId: 'main',
    runId: () => 'fixture-main-run', assertCurrent: current,
    responseFor: () => createResponseV4Envelope({ messageCandidate: null }, { requestId: 'original-input',
      source: { type: 'main', agentId: 'main', runId: 'fixture-main-run' }, results: [result],
      lifecycle: { domainExecution: 'attempted', failure: null },
      responsePolicy: { preferredMode: 'deterministic', allowedModes: ['deterministic'] } }),
    presentation: { language: 'he', timezone: 'Asia/Jerusalem', now: f.clock().toISOString(),
      assertResponseCurrent: current, renderDomainResult: renderJessicaDomainResult } });
}

test('native room action: native Response owner prepares only the verified start and rechecks retained custody', async () => {
  const f = nativeRoomActionFixture(), result = validateDomainResult((await f.run()).details);
  const response = nativeActionResponse(f, result);
  const prepared = response.prepare({ text: 'Untrusted completion claim from Main' });
  assert.equal(prepared.text, 'הניקוי בחדר שביקשת התחיל.');
  assert.equal(response.snapshot().outcome, 'prepared');
  assert.equal(renderJessicaDomainResult({ ...result, facts: { ...result.facts,
    verificationScope: ['room_cleaning_completion'] } }, { language: 'he' }).kind, 'unsupported');
  f.source.cutoff.generation = 'replaced-input';
  assert.equal(response.beforeNativeDeliver(prepared, { kind: 'final' }), null);
  assert.equal(f.effects(), 1);
});

test('native room action: native Response preserves uncertain effects without an optimistic start or completion claim', async () => {
  const f = nativeRoomActionFixture(); f.unknown();
  const result = validateDomainResult((await f.run()).details);
  const prepared = nativeActionResponse(f, result).prepare({ text: 'Cleaning completed successfully' });
  assert.equal(prepared.text, 'לא הצלחתי לאמת את תחילת הניקוי. ייתכן שהפעולה בוצעה; לא אבצע אותה שוב אוטומטית.');
  assert.equal(result.effects.status, 'possible'); assert.equal(result.effects.reconciliation.required, true);
  assert.equal(f.effects(), 1);
});

function fixture() {
  const state = { live: true, reads: 0, revokeRead: false, revokeSerialize: false };
  const context: OpenClawPluginToolContext<2> = { agentId: 'main', requesterSenderId: 'fixture-private',
    deliveryContext: { channel: 'whatsapp', accountId: 'fixture-account', to: 'fixture-private' },
    assertInvocationCurrent() { assert(state.live, 'invocation retired'); } };
  const abort = new AbortController();
  const policy = loadPolicy({ version: '1', defaultDecision: 'deny', rules: ['read', 'control'].map(actionClass => ({ subject: 'reader', actionClass,
    deviceScope: 'jessica-vacuum', decision: 'allow' })) });
  const factory = createJessicaTaskToolFactory({ roster: { accountId: 'fixture-account', approvedIds: ['reader'],
    subjectForRoute: route => route === 'fixture-private' ? 'reader' : null }, policy,
    clock: () => new Date('2026-10-26T08:00:00Z'),
    async read(request, identity, authority) {
      assert.deepEqual(request, { operation: 'status' }); assert(identity); authority.assertCurrent(); state.reads++;
      if (state.revokeRead) state.live = false;
      return validateResult({ schemaVersion: '1', status: 'success', domain: 'jessica-vacuum', operation: 'status', verified: true,
        data: { kind: 'status', observedAt: '2026-10-26T08:00:00Z', sourceUpdatedAt: '2026-10-26T07:59:00Z', freshness: 'fresh',
          state: 'docked', batteryLevel: 90, activeSegments: [], currentSegment: null }, warnings: [], error: null, pendingContext: null }, null,
        new Date('2026-10-26T08:00:00Z'));
    }, jsonResult(value) { if (state.revokeSerialize) state.live = false;
      return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }; } });
  const tool = factory(context); assert(tool && !Array.isArray(tool)); return { state, context, abort, factory, tool };
}

for (const fault of ['none', 'forged-intent', 'foreign-source', 'foreign-caller', 'missing-caller', 'changed-source',
  'changed-caller', 'cancelled', 'retired-after-effect', 'changed-at-serialization', 'duplicate',
  'pending', 'pending-possible-effects', 'pending-multiple', 'pending-wrong-target', 'pending-v1', 'pending-null', 'pending-stale', 'pending-expired',
  'pending-replayed', 'pending-missing-history'] as const) {
  test(`Main intent entry retains original Jessica mutation custody: ${fault}`, async () => {
    const f = domainFixture(); let changed = false, effects = 0, taskLive = true;
    let retainedCompletion: (() => void) | undefined;
    const pendingCase = fault.startsWith('pending');
    const text = pendingCase ? 'The living room' : 'Clean the living room';
    const reference = { schemaVersion: 1 as const, domain: 'jessica-vacuum' as const,
      binding: { requesterId: 'fixture-private', conversationId: 'original-conversation' }, clarificationId: 'original-question' };
    const expiresAt = new Date(f.clock().getTime() + (fault === 'pending-expired' ? -1 : 600_000)).toISOString();
    const prior = validateDomainResult({ schemaVersion: 2, kind: 'benson.domain-result', domain: 'jessica-vacuum',
      domainSchemaVersion: '1', executionMode: 'agentic', operation: 'clean', outcome: { disposition: 'handled', status: 'clarification_required' },
      facts: { verified: false, verificationScope: [], data: { question: 'Which room did you mean?', candidates: [
        { room: fault === 'pending-wrong-target' ? 'hallway' : 'living_room', label: 'Living room' }] } },
      evidence: { observations: [], gaps: [] }, warnings: [], failures: { domain: null, handling: null },
      effects: fault === 'pending-possible-effects' ? { status: 'possible', refs: [], details: [], reconciliation: { required: true, reason: 'UNRESOLVED_DISPATCH' } } : { status: 'none', refs: [], details: [], reconciliation: { required: false, reason: null } }, uncertainty: fault === 'pending-possible-effects' ? [{ code: 'UNRESOLVED_DISPATCH' }] : [],
      pendingContext: { schemaVersion: 1, binding: reference.binding, expiresAt,
        value: { version: '1', clarificationId: reference.clarificationId, expiresAt } },
      content: { state: 'unavailable', reason: { code: 'DOMAIN_RENDERING_REQUIRED', detail: 'Render question' } } });
    const context: OpenClawPluginToolContext<2> = { agentId: 'main', sessionKey: 'actual-main', sessionId: 'actual-main-id',
      requesterSenderId: 'fixture-private', deliveryContext: { channel: 'whatsapp', accountId: 'fixture-account', to: 'fixture-private' },
      assertInvocationCurrent() { assert(taskLive, 'Task invocation retired'); f.authority.assertCurrent(); } };
    if (fault === 'missing-caller') delete context.sessionId;
    const create = createJessicaTaskToolFactory({ roster: { accountId: 'fixture-account', approvedIds: [...new Set(loadPolicy(f.policy).rules.map(rule => rule.subject))],
      subjectForRoute: route => route === 'fixture-private' ? 'oren' : null }, policy: loadPolicy(f.policy),
      read: async () => { throw new Error('Intent cannot use the status path'); },
      clock: f.clock,
      jsonResult(value, callId, assertCompletion) {
        assert.equal(callId, 'original-call'); assert.equal(typeof assertCompletion, 'function'); retainedCompletion = assertCompletion;
        if (fault === 'changed-at-serialization') changed = true;
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }; },
      task: {
        ...pendingCase && fault !== 'pending-missing-history' ? { async history() {
          return { results: Array.from({ length: fault === 'pending-multiple' ? 5 : 1 }, (_, i) => ({
            input: { entryId: 'persisted-question-' + i }, requestId: fault === 'pending-replayed' ? 'original-input' : 'question-input-' + i, entryId: 'question-result-' + i,
            result: i === 0 ? prior : validateDomainResult({ ...prior, pendingContext: { ...prior.pendingContext!,
              value: { ...prior.pendingContext!.value, clarificationId: 'other-' + i } } }) })),
            assertCurrent() { f.authority.assertCurrent(); }, assertRetainedCurrent() { f.authority.assertCurrent(); } };
        } } : {},
        source: () => ({ request: text,
          binding: { conversationRef: 'original-conversation', channel: 'whatsapp', accountId: fault === 'foreign-source' ? 'foreign' : 'fixture-account',
            kind: 'direct', peerId: 'fixture-private', threadId: null, requesterId: 'fixture-private' },
          currentTurn: () => ({ entryId: changed ? 'replacement' : 'original-input', role: 'user', text,
            sender: { source: 'canonical_peer_binding', id: 'fixture-private', channel: 'whatsapp', accountId: 'fixture-account' }, inputProvenance: { kind: 'external_user' } }),
          assertCurrent() { f.authority.assertCurrent(); }, assertAuthorized() { f.authority.assertCurrent(); } }),
        async run(_request, work) {
          assert.equal(work.execution.requestEpoch, 'original-input'); assert.deepEqual(work.execution.identity, f.identity);
          if (fault === 'changed-source') changed = true;
          if (fault === 'changed-caller') context.sessionId = 'replacement';
          if (fault === 'cancelled') f.abort.abort();
          const rawFactory = createJessicaExecuteToolFactory({ registryConfig: f.registry, policyConfig: f.policy,
            roster: { accountId: 'fixture-account', approvedIds: [...new Set(loadPolicy(f.policy).rules.map(rule => rule.subject))], subjectForRoute: () => null },
            source: work.execution, store: f.store, clock: f.clock, wait: async () => {}, pollCounts: { clean: 1 },
            ...work.pending ? { pending: work.pending } : {},
            driver: { async read() { return structuredClone(f.evidence); }, async dispatch(_step, guard) {
              await guard.assertMutationCurrent(); guard.assertCurrent(); effects++; f.tick(); const at = f.clock().toISOString();
              f.evidence.status = { observedAt: at, sourceUpdatedAt: at, state: 'cleaning', activeSegments: [f.room.segmentId], currentSegment: null };
              f.evidence.taskStatus = { observedAt: at, sourceUpdatedAt: at, state: 'room_cleaning' };
              if (fault === 'retired-after-effect') f.retire();
              return { accepted: true };
            } }, jsonResult: (value, verify, callId) => {
              assert.equal(callId, 'actual-child-call'); assert.equal(typeof verify, 'function');
              return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }; } });
          const raw = rawFactory({ agentId: 'jessica-vacuum', sessionKey: 'agent:jessica-vacuum:subagent:actual',
            assertInvocationCurrent: work.execution.authority.assertCurrent }); assert(raw && !Array.isArray(raw));
          const value = normalizeLegacyTaskResult((await raw.execute('actual-child-call', f.request)).details,
            { taskId: work.callId, pendingBinding: null, pendingExpiresAt: null });
          assert(plain(value.data) && typeof value.data.operationId === 'string');
          const details = [{ kind: 'jessica-dispatch', operationId: value.data.operationId, verified: true }];
          const facts = { domain: value.domain, domainSchemaVersion: value.domainSchemaVersion, operation: value.operation,
            status: value.status, verified: value.verified, verificationScope: ['room_cleaning'], data: value.data,
            warnings: value.warnings, error: value.error, pendingContext: null, effects: details, uncertainty: [] };
          const binding = { inputId: 'original-input', admissionId: 'original-input', conversationId: 'original-conversation',
            runId: 'actual-child', agentId: 'jessica-vacuum', sessionKey: 'agent:jessica-vacuum:subagent:actual', sessionId: 'actual-child-id',
            domain: 'jessica-vacuum', taskId: work.callId, caller: { runId: 'main-run', agentId: 'main', sessionKey: 'actual-main',
              sessionId: fault === 'foreign-caller' ? 'foreign' : 'actual-main-id' }, completionTarget: 'CALLER', authorizationId: 'original-input',
            parentContinuation: { eligible: true, reason: null }, deliveryPolicy: { eligible: false, reason: null } };
          const authority = createCompletionAuthority({ schemaVersion: 6, kind: 'domain-task', binding, knownFacts: facts,
            results: [], coverage: 'complete', gaps: [], origin: 'agent' }, { assertCurrent: f.authority.assertCurrent });
          const completion = acceptAgentCompletion({ schemaVersion: 6, kind: 'domain-task', facts,
            userResponse: { state: 'unavailable', reason: { code: 'DOMAIN_RENDERING_REQUIRED', detail: 'Use verified domain facts' } } }, authority);
          return { completion, authority, effects: { status: 'known', refs: ['isolated-dispatch'], details, reconciliation: { required: false, reason: null } } };
        },
      } });
    const tool = create(context); assert(tool && !Array.isArray(tool));
    const request = { kind: 'benson.self-contained-request', version: pendingCase && fault !== 'pending-v1' ? 2 : 1,
      request: fault === 'forged-intent' ? 'replacement' : text,
      ...pendingCase && fault !== 'pending-v1' ? { pending: fault === 'pending-null' ? null : {
        ...reference, clarificationId: fault === 'pending-stale' ? 'stale' : reference.clarificationId } } : {} };
    const output = tool.execute('original-call', request, f.abort.signal);
    if (fault === 'none' || fault === 'duplicate' || fault === 'pending' || fault === 'pending-multiple') {
      const result = validateDomainResult((await output).details); assert.equal(result.executionMode, 'agentic');
      assert.equal(result.facts.verified, true); assert.equal(result.effects.status, 'known'); assert.equal(effects, 1);
      if (pendingCase) assert.deepEqual(JSON.parse(JSON.stringify(readDomainFactsData(result.facts.data).consumedPending)), reference);
      if (fault === 'duplicate') { await assert.rejects(tool.execute('retry', request), /already_started/); assert.equal(effects, 1); }
      assert(retainedCompletion); taskLive = false; retainedCompletion();
      await assert.rejects(tool.execute('after-retirement', request), /Task invocation retired/);
      f.retire(); assert.throws(retainedCompletion);
    } else { await assert.rejects(output); assert.equal(effects, ['foreign-caller', 'retired-after-effect', 'changed-at-serialization'].includes(fault) ? 1 : 0); }
  });
}
test('Main status adapter returns lossless domain facts and prepared content without a child Run', async () => {
  const f = fixture(), output = await f.tool.execute('fixture-call', { operation: 'status' }, f.abort.signal);
  const result = validateDomainResult(output.details), content = output.content[0]; assert(content?.type === 'text');
  assert.deepEqual(JSON.parse(content.text), JSON.parse(JSON.stringify(result))); assert.equal(result.executionMode, 'deterministic');
  assert.equal(result.facts.verified, true); assert.equal(result.effects.status, 'none');
  assert(plain(result.facts.data)); assert.equal(result.facts.data.batteryLevel, 90); assert(result.content?.state === 'usable'); assert.equal(f.state.reads, 1);
});
for (const mode of ['foreign-account', 'missing-route', 'missing-group-sender', 'foreign-group-sender', 'private-mismatch',
  'forged-params', 'mutation', 'closed', 'aborted', 'async-assertion', 'revoke-read', 'revoke-serialize'] as const) {
  test(`Main status refuses ${mode}`, async () => {
    const f = fixture(); let request: unknown = { operation: 'status' };
    if (mode === 'foreign-account') f.context.deliveryContext = { channel: 'whatsapp', accountId: 'foreign', to: 'fixture-private' };
    if (mode === 'missing-route') delete f.context.deliveryContext;
    if (mode === 'missing-group-sender' || mode === 'foreign-group-sender') {
      f.context.deliveryContext = { channel: 'whatsapp', accountId: 'fixture-account', to: 'fixture-group@g.us' };
      f.context.requesterSenderId = mode === 'missing-group-sender' ? '' : 'foreign';
    }
    if (mode === 'private-mismatch') f.context.requesterSenderId = 'foreign';
    if (mode === 'forged-params') request = { operation: 'status', senderId: 'foreign' };
    if (mode === 'mutation') request = { operation: 'clean', target: { kind: 'home' } };
    if (mode === 'closed') f.state.live = false;
    if (mode === 'aborted') f.abort.abort();
    if (mode === 'async-assertion') f.context.assertInvocationCurrent = async () => {};
    if (mode === 'revoke-read') f.state.revokeRead = true;
    if (mode === 'revoke-serialize') f.state.revokeSerialize = true;
    await assert.rejects(f.tool.execute('negative-call', request, f.abort.signal));
    assert.equal(f.state.reads, mode === 'revoke-read' || mode === 'revoke-serialize' ? 1 : 0);
  });
}
test('authorized group sender and optional signal preserve the existing read scope', async () => {
  const f = fixture(); f.context.deliveryContext = { channel: 'whatsapp', accountId: 'fixture-account', to: 'fixture-group@g.us' };
  await f.tool.execute('group-call', { operation: 'status' }); assert.equal(f.state.reads, 1);
  assert.equal(f.factory({ ...f.context, agentId: 'jessica-vacuum' }), null);
  f.state.live = false; await assert.rejects(f.tool.execute('retired-call', { operation: 'status' }));
});
for (const mode of ['success', 'foreign-agent', 'foreign-route', 'forged-input', 'disabled-operation', 'retired-after-read', 'retired-at-serialization', 'foreign-result',
  'missing-route', 'source-without-route', 'retired-source', 'cancelled-source', 'async-native-authority'] as const) {
  test(`domain raw read adapter preserves its existing boundary: ${mode}`, async () => {
    const f = domainFixture(); let live = true, reads = 0;
    let retainedCompletion: ((args: unknown, value: unknown) => void) | undefined;
    const sourceAbort = new AbortController();
    if (mode === 'cancelled-source') sourceAbort.abort();
    const policy = loadPolicy(f.policy);
    const create = createJessicaReadToolFactory({ registryConfig: f.registry, policy, clock: f.clock,
      roster: { accountId: 'fixture-account', approvedIds: [...new Set(policy.rules.map(rule => rule.subject))],
        subjectForRoute: route => route === 'fixture-private' ? 'oren' : null },
      ...(['source-without-route', 'retired-source', 'cancelled-source'].includes(mode) ? {
        source: { identity: f.identity, authority: { signal: sourceAbort.signal,
          assertCurrent() { assert(mode !== 'retired-source', 'original source retired'); } } },
      } : {}),
      async read(request, identity, authority) {
        assert.deepEqual(request, { operation: 'status' }); assert.deepEqual(identity, f.identity); authority.assertCurrent(); reads++;
        await Promise.resolve(); if (mode === 'retired-after-read') live = false;
        return validateResult({ schemaVersion: '1', status: 'success', domain: 'jessica-vacuum', operation: mode === 'foreign-result' ? 'capabilities' : 'status', verified: true,
          data: mode === 'foreign-result' ? { kind: 'capabilities', observedAt: f.clock().toISOString(), sourceUpdatedAt: null, freshness: 'fresh', capabilities: [], inventoryScope: 'accepted_registry_only', liveAvailability: 'not_checked' }
            : { kind: 'status', observedAt: f.clock().toISOString(), sourceUpdatedAt: null, freshness: 'fresh', state: 'docked', batteryLevel: 90, activeSegments: [], currentSegment: null },
          warnings: [], error: null, pendingContext: null }, null, f.clock());
      },
      jsonResult(value, callId, assertCompletion) {
        assert.equal(callId, 'raw-read'); assert.equal(typeof assertCompletion, 'function'); retainedCompletion = assertCompletion;
        assertCompletion({ operation: 'status' }, value);
        if (mode === 'retired-at-serialization') live = false;
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }; },
    });
    const ctx: OpenClawPluginToolContext<2> = { agentId: mode === 'foreign-agent' ? 'main' : 'jessica-vacuum', requesterSenderId: 'fixture-private',
      deliveryContext: { channel: 'whatsapp', accountId: mode === 'foreign-route' ? 'foreign' : 'fixture-account', to: 'fixture-private' },
      assertInvocationCurrent() { assert(live); } };
    if (['missing-route', 'source-without-route', 'retired-source', 'cancelled-source'].includes(mode)) delete ctx.deliveryContext;
    if (mode === 'async-native-authority') ctx.assertInvocationCurrent = async () => {};
    const tool = create(ctx);
    if (mode === 'foreign-agent') { assert.equal(tool, null); assert.equal(reads, 0); return; }
    assert(tool && !Array.isArray(tool)); const schema = Compile(tool.parameters);
    assert(schema.Check({ operation: 'status' })); assert(!schema.Check({ operation: 'room_settings', room: 'living_room' }));
    const request = mode === 'forged-input' ? { operation: 'status', requesterId: 'oren' } : mode === 'disabled-operation' ? { operation: 'room_settings', room: 'living_room' } : { operation: 'status' };
    const output = tool.execute('raw-read', request);
    if (mode !== 'success' && mode !== 'source-without-route') { await assert.rejects(output); assert.equal(reads, ['retired-after-read', 'retired-at-serialization', 'foreign-result'].includes(mode) ? 1 : 0); return; }
    const released = await output;
    const result = validateResult(released.details, null, f.clock());
    assert.equal(result.schemaVersion, '1'); assert.equal(result.operation, 'status'); assert.equal(result.verified, true); assert.equal(reads, 1);
    const text = released.content[0]; assert(text?.type === 'text' && typeof text.text === 'string');
    const view: unknown = JSON.parse(text.text);
    assert(plain(view) && plain(view.facts));
    assert.deepEqual(Object.keys(view).sort(), ['facts', 'schemaVersion']); assert.equal(view.schemaVersion, 2);
    assert.deepEqual(view.facts.verificationScope, ['status_read']); assert.deepEqual(view.facts.uncertainty, []);
    assert.equal(view.facts.domainSchemaVersion, result.schemaVersion); assert.deepEqual(view.facts.data, result.data);
    assert(!Object.hasOwn(view.facts, 'binding')); assert(!Object.hasOwn(result, 'facts'));
    assert(retainedCompletion); retainedCompletion(request, result);
    assert.throws(() => retainedCompletion!({ operation: 'rooms' }, result), /jessica_read_evidence_mismatch/);
    assert.throws(() => retainedCompletion!(request, { ...result, verified: false }), /jessica_read_evidence_mismatch/);
    live = false;
    if (mode === 'source-without-route') {
      retainedCompletion(request, result); sourceAbort.abort(); assert.throws(() => retainedCompletion!(request, result));
    } else assert.throws(() => retainedCompletion!(request, result));
    assert.equal(reads, 1);
  });
}

test('domain read presentation preserves raw v1 for other reads and failures', async () => {
  for (const operation of ['capabilities', 'status'] as const) {
    const f = domainFixture(), policy = loadPolicy(f.policy);
    const raw = validateResult({ schemaVersion: '1', domain: 'jessica-vacuum', operation,
      status: operation === 'status' ? 'failure' : 'success', verified: operation !== 'status',
      data: operation === 'status' ? null : { kind: 'capabilities', observedAt: f.clock().toISOString(), sourceUpdatedAt: null,
        freshness: 'fresh', capabilities: [], inventoryScope: 'accepted_registry_only', liveAvailability: 'not_checked' },
      warnings: [], error: operation === 'status' ? { code: 'SOURCE_UNAVAILABLE', stage: 'verification', retryable: false,
        retryMode: 'none', sideEffects: 'none', message: 'Synthetic read failure' } : null, pendingContext: null }, null, f.clock());
    const create = createJessicaReadToolFactory({ registryConfig: f.registry, policy, clock: f.clock,
      roster: { accountId: 'fixture-account', approvedIds: [...new Set(policy.rules.map(rule => rule.subject))],
        subjectForRoute: route => route === 'fixture-private' ? 'oren' : null },
      async read() { return raw; }, jsonResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }; } });
    const tool = create({ agentId: 'jessica-vacuum', requesterSenderId: 'fixture-private',
      deliveryContext: { channel: 'whatsapp', accountId: 'fixture-account', to: 'fixture-private' }, assertInvocationCurrent() {} });
    assert(tool && !Array.isArray(tool)); const result = await tool.execute('read', { operation });
    const text = result.content[0]; assert(text?.type === 'text' && typeof text.text === 'string');
    assert.deepEqual(JSON.parse(text.text), raw); assert.deepEqual(result.details, raw);
  }
});

for (const mode of ['success', 'missing-log', 'throwing-log', 'retired', 'cancelled', 'invalid-result', 'logger-revocation'] as const) {
  test(`delegated read diagnostic preserves privacy and live guards (unit mock): ${mode}`, async () => {
    const f = domainFixture(), abort = new AbortController(), messages: string[] = [];
    let live = true, reads = 0;
    const current = () => assert(live, 'mock native scope retired');
    const context = { agentId: 'jessica-vacuum', sessionKey: 'actual-child-key', sessionId: 'actual-child-session',
      assertInvocationCurrent: current,
      delegatedRequester: { contract: 'openclaw.requester-delegation.v1' as const,
        parent: { agentId: 'main', sessionKey: 'actual-parent-key', sessionId: 'actual-parent-session',
          runId: 'actual-parent-run', toolName: 'jessica_task', toolCallId: 'actual-parent-call' },
        child: { agentId: 'jessica-vacuum', sessionKey: 'actual-child-key', sessionId: 'actual-child-session', runId: 'actual-child-run' },
        requester: { senderId: 'fixture-private', deliveryContext: { channel: 'whatsapp', accountId: 'fixture-account', to: 'fixture-private' } },
        signal: abort.signal, assertCurrent: current } };
    const roster = { accountId: 'fixture-account', approvedIds: [...new Set(loadPolicy(f.policy).rules.map(rule => rule.subject))],
      subjectForRoute: (route: string) => route === 'fixture-private' ? 'oren' : null };
    const source = resolveJessicaRequesterDelegation(context, roster, mode === 'missing-log' ? undefined : message => {
      if (mode === 'throwing-log') throw Error('sensitive logger failure must not escape');
      messages.push(message); if (mode === 'logger-revocation') live = false;
    });
    assert(source);
    const tool = createJessicaReadToolFactory({ roster, source, registryConfig: f.registry, policy: loadPolicy(f.policy), clock: f.clock,
      async read(_request, _identity, authority) {
        authority.assertCurrent(); reads++;
        const at = f.clock().toISOString();
        return validateResult({ schemaVersion: '1', domain: 'jessica-vacuum', operation: 'status', status: 'success', verified: true,
          data: { kind: 'status', observedAt: at, sourceUpdatedAt: at, freshness: 'fresh', state: 'docked', batteryLevel: 90,
            activeSegments: [], currentSegment: null }, warnings: [], error: null, pendingContext: null }, null, f.clock());
      }, jsonResult(value) {
        if (mode === 'invalid-result') throw Error('serialization refused');
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
      } })(context);
    assert(tool && !Array.isArray(tool));
    if (mode === 'retired') live = false;
    if (mode === 'cancelled') abort.abort();
    const output = tool.execute('actual-child-call', { operation: 'status' });
    if (['retired', 'cancelled', 'invalid-result', 'logger-revocation'].includes(mode)) await assert.rejects(output);
    else assert.equal(validateResult((await output).details, null, f.clock()).status, 'success');
    assert.equal(reads, ['retired', 'cancelled'].includes(mode) ? 0 : 1);
    assert.equal(messages.length, ['success', 'logger-revocation'].includes(mode) ? 1 : 0);
    if (messages.length) {
      const line = messages[0]!;
      for (const sensitive of ['fixture-private', 'fixture-account', 'actual-parent', 'actual-child', 'batteryLevel', 'docked', 'assertCurrent', 'signal'])
        assert(!line.includes(sensitive), 'no raw identifiers, result content or handles');
      const observation: unknown = JSON.parse(line.slice('benson.jessica_g1b '.length));
      assert(plain(observation) && plain(observation.parent) && plain(observation.child));
      const hash = (v: string) => createHash('sha256').update(v).digest('hex');
      assert.equal(observation.parent.toolCallIdSha256, hash('actual-parent-call'));
      assert.equal(observation.child.runIdSha256, hash('actual-child-run'));
      assert.deepEqual(observation.read, { operation: 'status', status: 'success', verified: true });
      assert.equal(observation.phase, 'read_validated');
    }
    live = false;
    const count = messages.length;
    source.observeRead?.('retired-projection', { operation: 'status', status: 'success', verified: true });
    assert.equal(messages.length, count, 'retired source cannot emit new binding evidence');
  });
}

// Completion proof is deliberately synthetic. Vendor task IDs are absent; the
// private inert adapter attests the otherwise-unproven independent composite.
import { createJessicaCompletionEventEntry } from '../../../../../agents/jessica-vacuum/lib/task.js';
import { loadRegistry } from '../../../../../agents/jessica-vacuum/lib/registry.js';
import { createOperationState } from '../../../../../agents/jessica-vacuum/lib/operation-state.js';
import { createHaEventService, type HaEventConnection } from '../../../benson-routing/adapters/openclaw/ha-event-service.js';

async function completionEventFixture() {
  const f = roomActionFixture(), started = await f.run();
  assert(plain(started.facts.data) && typeof started.facts.data.operationId === 'string');
  const operationId = started.facts.data.operationId;
  const binding = await f.executor.state.correlation(operationId); assert(binding);
  const start = f.clock().toISOString(); f.tick(); f.tick(); f.tick(); const end = f.clock().toISOString();
  const proof = { version: '1' as const, level: 'simulated' as const, sourceRef: 'fixture-completion-source', inputId: 'bound-by-fixture',
    operationId, ownerGeneration: binding.owner.generation, requestHash: binding.requestHash, planHash: binding.planHash,
    identity: { kind: 'single-active-operation' as const, sourceGeneration: 'fixture-uninterrupted-generation',
      observedFrom: binding.createdAt, observedThrough: end, gap: false, replaced: false, rebooted: false },
    mapId: f.registry.mapBinding.mapId, mapFingerprint: binding.plan.mapFingerprint, mapGeneration: binding.plan.mapGeneration,
    segments: [f.room.segmentId], start: { observedAt: start, sourceReadAt: start, positiveProgress: 1 },
    terminal: { observedAt: end, sourceReadAt: end, successful: true, interrupted: false,
      historyRef: 'fixture-independent-history-row', mapId: f.registry.mapBinding.mapId, segments: [f.room.segmentId] } };
  const state = { supported: true, live: true, witnessLive: true, routeAllowed: true, closes: 0, failures: 0,
    results: [] as ReturnType<typeof validateDomainResult>[], receive: (_: string) => {}, gap: () => {},
    beforeEvidence: async () => {} };
  const createEntry = () => createJessicaCompletionEventEntry({ registry: loadRegistry(f.registry), policyConfig: f.policy,
    roster: { ...f.deps.roster, subjectForRoute: route => state.routeAllowed ? f.deps.roster.subjectForRoute(route) : null },
    state: f.executor.state, source: f.source, now: () => f.clock().getTime(),
    readAuthority(input) { return { inputId: input.source.inputId, sourceType: 'ha', sourceRef: proof.sourceRef,
      domain: 'jessica-vacuum', subject: 'fixture-observer', authorityRef: 'fixture-read-only', authorityRevision: '1',
      scopes: ['read'], expiresAt: f.clock().getTime() + 60_000, status: 'active', cancelled: false, replayState: 'fresh', commitment: 'uncommitted' }; },
    async readEvidence(input) {
      await state.beforeEvidence(); if (!state.supported) return null;
      const retained = structuredClone({ ...proof, inputId: input.source.inputId });
      return { proof: retained, assertCurrent(value) { assert(state.witnessLive, 'fixture witness revoked'); assert.deepEqual(value, retained); } };
    } });
  const connection: HaEventConnection = { sourceRef: proof.sourceRef, subscriptionId: 19,
    assertCurrent() { assert(state.live, 'fixture source retired'); },
    async subscribe(_type, receive, gap) { state.receive = receive; state.gap = gap; return () => {}; },
    close() { state.closes++; } };
  const service = createHaEventService({ sourceRef: proof.sourceRef,
    entries: [{ domain: 'jessica-vacuum', ...createEntry() }], async connect() { return connection; },
    observe(result) { state.results.push(validateDomainResult(result)); } });
  const context = { config: {}, stateDir: '/unused', logger: { info() {}, warn() {}, error() {}, debug() {} },
    serviceHealth: { reportFailure() { state.failures++; }, clearFailure() {} } };
  await service.start(context);
  const frame = { id: 19, type: 'event', event: { event_type: 'state_changed', time_fired: end,
    data: { entity_id: 'vacuum.jesica_jesica', new_state: { entity_id: 'vacuum.jesica_jesica', state: 'docked', last_updated: end,
      attributes: { has_error: false, task_status_device_observation: { value: 0, source_read_at: end } } } } } };
  async function send(value: unknown = frame) { state.receive(JSON.stringify(value)); await new Promise<void>(resolve => setImmediate(resolve)); }
  return { ...f, state, started, operationId, binding, proof, frame, service, context, createEntry, send };
}

test('completion event: simulated Tal start to correlated terminal DomainResult and original-route Response, no provider taskId/send/release', async () => {
  const f = await completionEventFixture(); await f.send();
  assert.equal(f.state.failures, 0); assert.equal(f.state.results.length, 1);
  const result = f.state.results[0]!; assert.equal(result.executionMode, 'deterministic');
  assert.equal(result.operation, 'clean_completion'); assert.equal(result.outcome.status, 'success');
  assert.equal(result.facts.verified, true); assert.deepEqual(result.facts.verificationScope, ['simulated_room_cleaning_completion']);
  assert(plain(result.facts.data)); assert.equal(result.facts.data.operationId, f.operationId);
  assert.equal(result.facts.data.proofLevel, 'simulated'); assert.equal(result.facts.data.room, 'living_room');
  assert.deepEqual(JSON.parse(JSON.stringify(result.facts.data.originalReturnRoute)), f.source.binding);
  assert.equal(result.effects.status, 'none'); assert.match(result.content?.state === 'usable' ? result.content.text : '', /^Simulation only:/);
  assert.equal(f.effects(), 1); assert.deepEqual((await f.executor.state.resource()).owner, f.binding.owner);
  const row = f.store.data.get('device:jessica-vacuum'); assert(plain(row)); assert.equal(row.version, '4');
  // Existing start/history is immutable; physical completion is separately claimed.
  assert.deepEqual((await f.executor.state.operation(f.operationId))?.value, await f.executor.state.history(f.binding.owner.requestKey).then(v => v?.result));
  assert.equal(await createOperationState(f.store, { verifyRelease: () => true }).releaseResource(f.binding.owner, {}), false);
  await f.service.stop?.(f.context);
});

test('completion event: duplicate is durably suppressed after consumer reconstruction, with custody retained', async () => {
  const f = await completionEventFixture(); await f.send(); await f.send();
  assert.equal(f.state.results[1]?.outcome.disposition, 'suppressed');
  assert.equal(f.state.results[1]?.content, null);
  const entry = f.createEntry(); const request = entry.prepareRequest(f.frame);
  // A reconstructed source uses another event identity; still one claim per owned operation.
  const result = await entry.execute({ schemaVersion: 1, kind: 'benson.source-input', domain: 'jessica-vacuum', scope: 'read',
    source: { type: 'ha', ref: f.proof.sourceRef, inputId: 'fixture-after-reconstruction' }, request }, () => {});
  assert.equal(result.outcome.disposition, 'suppressed'); assert.equal(result.content, null);
  assert.equal((await f.executor.state.resource()).owner?.operationId, f.operationId);
  await f.service.stop?.(f.context);
});

for (const fault of ['unqualified-dreame', 'foreign-operation', 'foreign-owner-generation', 'foreign-request-hash', 'wrong-room', 'wrong-terminal-room',
  'wrong-map', 'gap', 'external-replacement', 'reboot', 'interrupted', 'failed-terminal', 'stale-frame', 'error-frame',
  'wrong-device', 'zero-progress', 'revoked-original', 'changed-cutoff', 'foreign-current-input', 'unauthorized-route', 'revoked-witness', 'owner-changed', 'original-text-changed', 'unknown-version'] as const) {
  test(`completion event: fail closed ${fault}`, async () => {
    const f = await completionEventFixture();
    if (fault === 'unqualified-dreame') f.state.supported = false;
    if (fault === 'foreign-operation') f.proof.operationId = 'foreign-operation';
    if (fault === 'foreign-owner-generation') f.proof.ownerGeneration++;
    if (fault === 'foreign-request-hash') f.proof.requestHash = 'foreign-request';
    if (fault === 'wrong-room') f.proof.segments = [999];
    if (fault === 'wrong-terminal-room') f.proof.terminal.segments = [999];
    if (fault === 'wrong-map') f.proof.mapFingerprint = 'foreign-map';
    if (fault === 'gap') f.proof.identity.gap = true;
    if (fault === 'external-replacement') f.proof.identity.replaced = true;
    if (fault === 'reboot') f.proof.identity.rebooted = true;
    if (fault === 'interrupted') f.proof.terminal.interrupted = true;
    if (fault === 'failed-terminal') f.proof.terminal.successful = false;
    if (fault === 'stale-frame') f.frame.event.data.new_state.attributes.task_status_device_observation.source_read_at = '2000-01-01T00:00:00Z';
    if (fault === 'error-frame') f.frame.event.data.new_state.attributes.has_error = true;
    if (fault === 'wrong-device') f.frame.event.data.new_state.entity_id = 'vacuum.foreign';
    if (fault === 'zero-progress') f.proof.start.positiveProgress = 0;
    if (fault === 'revoked-original') f.retire();
    if (fault === 'changed-cutoff') f.source.cutoff.generation = 'later-generation';
    if (fault === 'foreign-current-input') f.source.currentTurn = () => ({ entryId: 'foreign-input', role: 'user', text: f.source.request,
      sender: { source: 'canonical_peer_binding', id: 'tal-route', channel: 'whatsapp', accountId: 'fixture-account' }, inputProvenance: { kind: 'external_user' } });
    if (fault === 'unauthorized-route') f.state.routeAllowed = false;
    if (fault === 'revoked-witness') f.state.witnessLive = false;
    if (fault === 'unknown-version') Reflect.set(f.proof, 'version', '99');
    if (fault === 'original-text-changed') f.state.beforeEvidence = async () => { f.source.request = 'Clean the hallway'; };
    if (fault === 'owner-changed') f.state.beforeEvidence = async () => {
      const row = structuredClone(f.store.data.get('device:jessica-vacuum')); assert(plain(row) && plain(row.resource));
      row.resource.uncertain = true; f.store.data.set('device:jessica-vacuum', row);
    };
    await f.send();
    assert(!f.state.results.some(result => result.facts.verified === true));
    assert(f.state.results.every(result => result.outcome.disposition !== 'handled'));
    const row = f.store.data.get('device:jessica-vacuum'); assert(plain(row)); assert.notEqual(row.version, '4');
    assert.equal(f.effects(), 1); assert.equal((await f.executor.state.resource()).owner?.operationId, f.operationId);
    await f.service.stop?.(f.context);
  });
}

test('completion event: concurrent consumers prepare at most one success through canonical CAS', async () => {
  const f = await completionEventFixture(); const entry = f.createEntry();
  const input = (id: string) => ({ schemaVersion: 1 as const, kind: 'benson.source-input' as const,
    domain: 'jessica-vacuum' as const, scope: 'read' as const,
    source: { type: 'ha' as const, ref: f.proof.sourceRef, inputId: id }, request: entry.prepareRequest(f.frame) });
  const results = await Promise.all([entry.execute(input('fixture-one'), () => {}), entry.execute(input('fixture-two'), () => {})]);
  assert.equal(results.filter(result => result.outcome.disposition === 'handled').length, 1);
  assert.equal((await f.executor.state.resource()).owner?.operationId, f.operationId);
  await f.service.stop?.(f.context);
});

test('completion event: custody becomes uncertain after claim, so no successful Response is prepared', async () => {
  const f = await completionEventFixture();
  f.store.beforeLookup = async key => {
    if (key !== 'device:jessica-vacuum') return;
    const row = structuredClone(f.store.data.get(key));
    if (plain(row) && row.version === '4' && plain(row.resource)) { row.resource.uncertain = true; f.store.data.set(key, row); }
  };
  await f.send(); assert(!f.state.results.some(result => result.facts.verified === true));
  f.store.beforeLookup = undefined;
  const row = f.store.data.get('device:jessica-vacuum'); assert(plain(row)); assert.equal(row.version, '4');
  assert.equal((await f.executor.state.resource()).uncertain, true);
  await f.service.stop?.(f.context);
});

function ingressActionFixture() {
  const f = roomActionFixture(); let releaseLive = true;
  const origin = { version: '2' as const, kind: 'native-ingress' as const, binding: f.source.binding, messageId: 'native-message-id',
    inputId: ingressInputId(f.source.binding, 'native-message-id'), textHash: ingressTextHash(f.source.request) };
  const source: NativeCurrentInputEvidence = { ...f.source, origin,
    currentTurn() { return { entryId: origin.inputId, role: 'user', text: this.request,
      sender: { source: 'canonical_peer_binding', id: 'tal-route', channel: 'whatsapp', accountId: 'fixture-account' },
      inputProvenance: { kind: 'external_user' } }; }, assertRetainedCurrent() { assert(releaseLive, 'Native release retired'); } };
  const run = () => executeJessicaRoomTask({ kind: 'benson.self-contained-request', version: 1, request: source.request },
    { ...f.deps, source, assertResultCurrent() { assert(releaseLive, 'Domain release retired'); } });
  return { ...f, source, origin, run, retireRelease() { releaseLive = false; } };
}
test('ingress identity: exact replay reuses result and altered exact text cannot reuse terminal history', async () => {
  const f = ingressActionFixture(), first = await f.run(); assert.equal(first.outcome.status, 'success');
  assert.deepEqual(await f.run(), first); assert.equal(f.effects(), 1);
  const record = f.store.data.get('device:jessica-vacuum'); assert(plain(record)); assert.equal(record.version, '5');
  const owner = await f.executor.state.resource(); assert(owner.owner);
  assert.equal((await f.executor.state.correlation(owner.owner.operationId))?.version, '2');
  const index = f.store.data.get('operation:' + owner.owner.operationId); assert(plain(index)); assert.equal(index.version, '3');
  const stable = f.origin.inputId;
  Object.assign(f.source, { request: 'clean the living room' }); f.origin.textHash = ingressTextHash(f.source.request);
  assert.equal(f.origin.inputId, stable); // Same semantic room command, different original bytes.
  await assert.rejects(f.run); assert.equal(f.effects(), 1);
});
for (const fault of ['text-commitment', 'origin-version', 'input-identity'] as const) {
  test('ingress identity rejects ' + fault, async () => {
    const f = ingressActionFixture();
    if (fault === 'text-commitment') f.origin.textHash = '0'.repeat(64);
    if (fault === 'origin-version') Object.assign(f.origin, { version: '99' });
    if (fault === 'input-identity') f.origin.inputId = '0'.repeat(64);
    await assert.rejects(f.run); assert.equal(f.effects(), 0);
  });
}

test('ingress custody rejects asynchronous policy authority before any effect', async () => {
  const f = ingressActionFixture();
  await assert.rejects(() => executeJessicaRoomTask({ kind: 'benson.self-contained-request', version: 1, request: f.source.request },
    { ...f.deps, source: f.source, async assertResultCurrent() {} }));
  assert.equal(f.effects(), 0);
});
