import test from 'node:test';
import assert from 'node:assert/strict';
import type { OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import { Compile } from 'typebox/compile';
import Type from 'typebox';
import { fixture } from './fixtures/domain-state.js';
import { createJessicaExecuteToolFactory } from '../src/execute-tool.js';
import { loadPolicy } from '../../../../../agents/jessica-vacuum/lib/policy.js';
import type { JessicaDevice, DeviceStep } from '../../../../../agents/jessica-vacuum/lib/ports.js';
import { plain } from '../../../benson-routing/core/value.js';
import { createOperationState } from '../../../../../agents/jessica-vacuum/lib/operation-state.js';

function setup() {
  const f = fixture(), trace: DeviceStep[] = [], policy = loadPolicy(f.policy);
  let childLive = true, revokeOnRead = false, retireAfterPost = false;
  const driver: JessicaDevice = { async read() {
    if (revokeOnRead) f.retire();
    const result = structuredClone(f.evidence); result.status.observedAt = f.clock().toISOString();
    if (result.map) result.map.observedAt = f.clock().toISOString();
    return result;
  }, async dispatch(step, guard) {
    await guard.assertMutationCurrent(); guard.assertCurrent(); guard.signal.throwIfAborted();
    trace.push(step); f.tick();
    const at = f.clock().toISOString();
    f.evidence.status = { observedAt: at, sourceUpdatedAt: at, state: 'cleaning', activeSegments: [f.room.segmentId], currentSegment: null };
    f.evidence.taskStatus = { observedAt: at, sourceUpdatedAt: at, state: 'room_cleaning' };
    if (retireAfterPost) f.retire();
    return { accepted: true };
  } };
  const source = { identity: f.identity, requestEpoch: 'original-message-id', authority: f.authority };
  const create = createJessicaExecuteToolFactory({ registryConfig: f.registry, policyConfig: f.policy,
    roster: { accountId: 'fixture', approvedIds: [...new Set(policy.rules.map(rule => rule.subject))], subjectForRoute: () => null },
    store: f.store, driver, clock: f.clock, wait: async () => {}, pollCounts: { clean: 1 }, source,
    jsonResult: value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value }) });
  const context: OpenClawPluginToolContext<2> = { agentId: 'jessica-vacuum', sessionKey: 'agent:jessica-vacuum:subagent:actual-child',
    assertInvocationCurrent() { assert(childLive, 'child retired'); } };
  const tool = create(context); assert(tool && !Array.isArray(tool));
  return { ...f, create, context, tool, source, trace,
    retireChild() { childLive = false; }, revokeRead() { revokeOnRead = true; }, retireAfterPost() { retireAfterPost = true; } };
}
test('native mutation tool uses original epoch across child sessions and preserves one verified effect', async () => {
  const f = setup();
  const first = await f.tool.execute('call-a', f.request);
  const result = first.details; assert(plain(result)); assert.equal(result.status, 'success'); assert.equal(result.verified, true); assert.equal(f.trace.length, 1);
  const next = f.create({ ...f.context, sessionKey: 'agent:jessica-vacuum:subagent:different-child' }); assert(next && !Array.isArray(next));
  assert.deepEqual((await next.execute('different-call', f.request)).details, first.details); assert.equal(f.trace.length, 1);
  assert.equal((await createOperationState(f.store).resource()).owner?.requestEpoch, 'original-message-id');
  const parameters = Compile(Type.Unsafe(f.tool.parameters));
  assert(parameters.Check(f.request)); assert(!parameters.Check({ operation: 'resume' }));
  assert(!parameters.Check({ ...f.request, requestEpoch: 'forged' }));
});
test('missing child custody, retired source/child, cancellation and revocation during read prevent mutation', async () => {
  const f = setup(); assert.equal(f.create({ ...f.context, agentId: 'main' }), null);
  assert.equal(f.create({ ...f.context, sessionKey: 'agent:jessica-vacuum:main' }), null);
  for (const invalidation of ['source', 'child', 'abort', 'read'] as const) {
    const g = setup();
    if (invalidation === 'source') g.retire();
    if (invalidation === 'child') g.retireChild();
    if (invalidation === 'abort') g.abort.abort();
    if (invalidation === 'read') g.revokeRead();
    await assert.rejects(g.tool.execute('blocked', g.request)); assert.equal(g.trace.length, 0);
  }
});
test('retirement after a dispatch preserves uncertain durable ownership and never replays', async () => {
  const f = setup(); f.retireAfterPost();
  await assert.rejects(f.tool.execute('uncertain', f.request)); assert.equal(f.trace.length, 1);
  const records = structuredClone(f.store.data);
  await assert.rejects(f.tool.execute('retry', f.request)); assert.equal(f.trace.length, 1); assert.deepEqual(f.store.data, records);
});
