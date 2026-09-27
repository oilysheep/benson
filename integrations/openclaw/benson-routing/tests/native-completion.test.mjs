import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test, { after } from 'node:test';
import { bindNativeCompletion, validateNativeCompletion } from '../completion-control.mjs';

const patch = fileURLToPath(new URL('../../patches/openclaw-2026.9.6-benson-completion-control.patch', import.meta.url));
const installed = process.env.OPENCLAW_PACKAGE_ROOT ??
  resolve(homedir(), '.npm-global/lib/node_modules/openclaw');
const scenario = process.argv[2];

if (scenario === 'fixture' || scenario === 'restart' || scenario?.startsWith('direct-')) {
  const root = process.env.OPENCLAW_S07_PACKAGE_ROOT + '/dist/';
  const [{ c: transaction }, { p: bindSubagent, s: readSubagent },
    { r: upsertSubagent }, { t: bindTask, v: upsertTask, d: readTask },
    { B2: admitDirect }, { j: subagentRuns }] = await Promise.all([
    import(root + 'openclaw-state-db-BFK9cMiV.mjs'),
    import(root + 'subagent-registry.store.sqlite-DcyWJbiA.mjs'),
    import(root + 'subagent-registry.store.kernel-BoNquCdf.mjs'),
    import(root + 'task-registry.store.kernel-BuNI8UuR.mjs'),
    import(root + 'subagent-completion-admission.store-Bw0OSK2O.mjs'),
    import(root + 'subagent-run-liveness-9vTRtoqd.mjs'),
  ]);
  const kind = process.argv[3];
  if (scenario.startsWith('direct-')) {
    const [{ ut: loadQueue }, { t: queueName }, { l: loadSession },
      { l: resolveStorePath }, { r: getRuntimeConfig },
      { B: prepareDirect }, { B: deliverFinal }, { B5: settleDirect }] = await Promise.all([
      import(root + 'openclaw-state-db-read-connection-Beg0AZE7.mjs'),
      import(root + 'session-delivery-queue.records-rYJIeHGW.mjs'),
      import(root + 'session-accessor.sqlite-entry-UCl9kr-O.mjs'),
      import(root + 'paths-CcMbq5NY.mjs'),
      import(root + 'io.runtime-hPN4FOBi.mjs'),
      import(root + 'subagent-completion-delivery-BlfHhlHm.mjs'),
      import(root + 'dispatch-from-config.finalize-B25V5wMZ.mjs'),
      import(root + 'subagent-completion-admission.store-Bw0OSK2O.mjs'),
    ]);
    const child = transaction((db) => readSubagent(db, 'child-run'));
    const queueEntry = transaction((db) => loadQueue(db, queueName, child.delivery.queueId));
    assert.equal(queueEntry.sourceType, 'direct');
    const cfg = getRuntimeConfig();
    const scope = { agentId: 'main', sessionKey: queueEntry.sessionKey,
      sessionId: queueEntry.expectedSessionId,
      storePath: resolveStorePath(cfg.session?.store, { agentId: 'main' }),
      env: { ...process.env } };
    assert.equal(loadSession(scope).sessionId, scope.sessionId);
    if (scenario === 'direct-worker') {
      const { t: deliverQueued } = await import(root + 'server-restart-sentinel-Bc_R9rEL.mjs');
      const before = loadSession(scope).bensonPendingFinals?.[0];
      await deliverQueued({ entry: queueEntry, queueContext: {
        admission: { assertCurrent() {} }, environment: { ...process.env } } });
      const persisted = loadSession(scope).bensonPendingFinals[0];
      assert.equal(persisted.deliveries[0].state, 'delivered');
      if (before) {
        assert.equal(persisted.text, before.text);
        assert.deepEqual(persisted.bensonFinal, before.bensonFinal);
        assert.equal(loadSession(scope).bensonPendingFinals.length, 1);
      }
      assert.equal(persisted.bensonReceipt.kind, 'webchat');
      const durable = transaction((db) => ({ child: readSubagent(db, 'child-run'),
        task: readTask(db.db, 'task') }));
      assert.equal(durable.child.delivery.status, 'delivered');
      assert.equal(durable.task.deliveryStatus, 'delivered');
    } else if (scenario === 'direct-prepare') {
      const prepared = await prepareDirect({ queueEntry, scope, cfg });
      assert.equal(prepared.replayed, false);
      assert.equal(loadSession(scope).bensonPendingFinals[0].text, prepared.text);
      assert.equal(child.delivery.status, 'in_progress');
    } else if (scenario === 'direct-deliver') {
      const delivered = await deliverFinal({ queueEntry, scope, cfg });
      assert.equal(delivered.status, 'delivered');
      assert.equal(delivered.receipt.kind, 'webchat');
      assert.equal(transaction((db) => readSubagent(db, 'child-run')).delivery.status, 'in_progress');
    } else if (scenario === 'direct-settle') {
      const pending = loadSession(scope).bensonPendingFinals[0];
      assert.equal(pending.deliveries[0].state, 'delivered');
      assert.equal(settleDirect(queueEntry, pending.bensonReceipt), 'settled');
      const durable = transaction((db) => ({ child: readSubagent(db, 'child-run'),
        task: readTask(db.db, 'task') }));
      assert.equal(durable.child.delivery.status, 'delivered');
      assert.equal(durable.task.deliveryStatus, 'delivered');
    } else if (scenario === 'direct-repeat') {
      const original = loadSession(scope).bensonPendingFinals[0];
      assert.equal((await prepareDirect({ queueEntry, scope, cfg })).replayed, true);
      assert.equal((await deliverFinal({ queueEntry, scope, cfg })).status, 'delivered');
      assert.equal(settleDirect(queueEntry, original.bensonReceipt), 'duplicate');
      const settledOwner = transaction((db) => readSubagent(db, 'child-run'));
      assert.equal(admitDirect({ runId: 'child-run', taskId: 'task',
        binding: settledOwner.bensonCompletionBinding,
        admission: settledOwner.bensonCompletionAdmission }).delivered, true);
      assert.equal(loadSession(scope).bensonPendingFinals.length, 1);
      assert.equal(loadSession(scope).bensonPendingFinals[0].text, original.text);
    } else throw new Error('unknown Direct phase');
    process.stdout.write(`${scenario} ${kind} PASS\n`);
  } else if (scenario === 'restart') {
    const durable = transaction((db) => ({ child: readSubagent(db, 'child-run'),
      task: readTask(db.db, 'task') }));
    if (kind === 'malformed') {
      assert.equal(durable.task.status, 'failed');
      assert.equal(durable.child.delivery.status, 'suspended');
      assert.equal(durable.child.bensonCompletionAdmission, undefined);
    } else {
      assert.equal(durable.task.status, 'succeeded');
      assert.equal(durable.child.bensonCompletionAdmission.destination,
        kind === 'direct' ? 'RESPONSE_CONTROLLER' : 'CALLER');
    }
    process.stdout.write(`restart ${kind} PASS\n`);
  } else {
    const direct = kind === 'direct';
    const malformed = kind === 'malformed';
    const pending = kind === 'pending';
    const now = Date.now();
    const commitment = { requestId: 'request', sessionId: 'parent-session',
      owner: direct ? 'jessica-vacuum' : 'main', phase: 'committed' };
    const binding = bindNativeCompletion({ commitment, sourceTurnId: 'request',
      parentSessionKey: 'agent:main:test', parentSessionId: 'parent-session', parentRunId: direct ? null : 'parent-run',
      childRunId: 'child-run', childSessionKey: 'agent:jessica-vacuum:subagent:test',
      executionOwner: 'jessica-vacuum',
      completionTarget: direct ? 'RESPONSE_CONTROLLER' : 'CALLER' });
    let domainResult = { schemaVersion: '1', status: 'success', domain: 'jessica-vacuum',
      operation: 'status', verified: true,
      data: { kind: 'status', observedAt: new Date(now).toISOString(),
        sourceUpdatedAt: new Date(now).toISOString(), freshness: 'fresh', state: 'docked',
        batteryLevel: 100, activeSegments: [], currentSegment: null },
      warnings: [], error: null, pendingContext: null };
    let final = domainResult;
    if (pending) {
      domainResult = { ...domainResult, operation: 'rooms', data: { kind: 'rooms',
        observedAt: new Date(now).toISOString(), sourceUpdatedAt: new Date(now).toISOString(),
        freshness: 'fresh', mapFingerprint: 'a'.repeat(64),
        rooms: [{ slug: 'salon', label: 'Salon', segmentId: 8, enabled: true }] } };
      final = { ...domainResult, status: 'clarification_required', operation: 'clean', verified: false,
        data: { question: 'Which room did you mean?', candidates: [{ room: 'salon', label: 'Salon' }] },
        pendingContext: { version: '1', clarificationId: 's07-clarification',
          expiresAt: new Date(now + 60_000).toISOString() } };
    }
    const child = { runId: 'child-run', taskRunId: 'child-run', childSessionKey: binding.childSessionKey,
      requesterSessionKey: binding.parentSessionKey, requesterTurnRunId: direct ? undefined : binding.parentRunId,
      agentId: 'jessica-vacuum', requesterAgentId: 'main', task: 'status', createdAt: now - 1000,
      cleanup: 'keep', expectsCompletionMessage: true, completionTarget: direct ? undefined : 'parent',
      execution: { status: 'terminal', startedAt: now - 900, endedAt: now - 500,
        outcome: { status: 'ok' } },
      completion: { required: true, resultText: '{broken', capturedAt: now - 500 },
      delivery: { status: 'pending' },
      requesterOrigin: { channel: 'webchat', to: 'benson-direct-test' },
      bensonCompletionBinding: binding };
    const task = { taskId: 'task', runtime: 'subagent', scopeKind: 'session',
      ownerKey: binding.parentSessionKey, requesterSessionKey: binding.parentSessionKey,
      childSessionKey: binding.childSessionKey, agentId: 'jessica-vacuum', requesterAgentId: 'main',
      runId: child.runId, task: 'status', status: 'running', deliveryStatus: 'pending',
      notifyPolicy: 'silent', createdAt: now - 1000, startedAt: now - 900, lastEventAt: now - 900 };
    transaction((db) => { upsertSubagent(db, bindSubagent(child)); upsertTask(db, bindTask(task)); });
    subagentRuns.set(child.runId, child);
    if (direct) {
      const result = { schemaVersion: 1, domainSchemaVersion: '1', taskId: 'task',
        status: 'success', domain: 'jessica-vacuum', operation: 'status', verified: true,
        data: { state: 'docked' }, warnings: [], error: null, pendingContext: null,
        messageCandidate: null };
      const admission = validateNativeCompletion({ binding, commitment,
        parentSession: { sessionKey: binding.parentSessionKey, sessionId: binding.parentSessionId },
        child, task, result });
      const [{ ut: loadQueueBefore }, { t: queueNameBefore, B: prepareQueue }] = await Promise.all([
        import(root + 'openclaw-state-db-read-connection-Beg0AZE7.mjs'),
        import(root + 'session-delivery-queue.records-rYJIeHGW.mjs'),
      ]);
      const expectedQueue = prepareQueue({ sessionKey: binding.parentSessionKey,
        sessionId: binding.parentSessionId, requestId: binding.requestId,
        sourceType: 'direct', sourceRunId: child.runId, taskId: task.taskId,
        deliveryContext: child.requesterOrigin });
      assert.throws(() => admitDirect({ runId: child.runId, taskId: task.taskId,
        binding, admission, testHooks: { afterMutation: () => { throw new Error('rollback probe'); } } }),
      /rollback probe/);
      const afterRollback = transaction((db) => ({ child: readSubagent(db, child.runId),
        task: readTask(db.db, task.taskId),
        queue: loadQueueBefore(db, queueNameBefore, expectedQueue.id) }));
      assert.equal(afterRollback.queue, null);
      assert.equal(afterRollback.child.bensonCompletionAdmission, undefined);
      assert.equal(afterRollback.task.status, 'running');
      const first = admitDirect({ runId: child.runId, taskId: task.taskId, binding, admission });
      const duplicate = admitDirect({ runId: child.runId, taskId: task.taskId, binding, admission });
      assert.equal(first.status, 'admitted');
      assert.equal(duplicate.status, 'duplicate');
      assert.equal(duplicate.queueId, first.queueId);
      const durable = transaction((db) => ({ child: readSubagent(db, child.runId),
        task: readTask(db.db, task.taskId) }));
      assert.equal(durable.task.status, 'succeeded');
      assert.equal(durable.task.deliveryStatus, 'session_queued');
      assert.equal(durable.child.delivery.disposition, 'benson_response_handoff');
      assert.equal(durable.child.delivery.deliveredAt, undefined);
      const [{ ut: loadQueue }, { t: queueName }] = await Promise.all([
        import(root + 'openclaw-state-db-read-connection-Beg0AZE7.mjs'),
        import(root + 'session-delivery-queue.records-rYJIeHGW.mjs'),
      ]);
      const queued = transaction((db) => loadQueue(db, queueName, first.queueId));
      assert.equal(queued.sourceRunId, child.runId);
      assert.equal(queued.taskId, task.taskId);
      assert.equal(queued.deliveryContext.to, 'benson-direct-test');
      const [{ d: patchSession }, { l: resolveStorePath }, { r: getRuntimeConfig }] =
        await Promise.all([
          import(root + 'session-accessor.sqlite-entry-UCl9kr-O.mjs'),
          import(root + 'paths-CcMbq5NY.mjs'),
          import(root + 'io.runtime-hPN4FOBi.mjs'),
        ]);
      const storePath = resolveStorePath(getRuntimeConfig().session?.store, { agentId: 'main' });
      await patchSession({ agentId: 'main', sessionKey: binding.parentSessionKey, storePath },
        () => ({ sessionId: binding.parentSessionId, updatedAt: now,
          bensonDecisionCommitments: [commitment] }),
        { fallbackEntry: { sessionId: binding.parentSessionId, updatedAt: now } });

      assert.throws(() => admitDirect({ runId: child.runId, taskId: task.taskId, binding,
        admission: { ...admission, result: { ...admission.result, operation: 'rooms' } } }),
      /contradicts/);
    } else {
      const [{ d: patchSessionEntryCore }, { l: resolveStorePath },
        { r: getRuntimeConfig }, { r: appendMessage },
        { prepareBensonNativeCompletion, t: admitCaller, r: resolveCorrelated }] = await Promise.all([
        import(root + 'session-accessor.sqlite-entry-UCl9kr-O.mjs'),
        import(root + 'paths-CcMbq5NY.mjs'),
        import(root + 'io.runtime-hPN4FOBi.mjs'),
        import(root + 'session-transcript-runtime-CePvNE-m.mjs'),
        import(root + 'subagent-completion-delivery-BlfHhlHm.mjs'),
      ]);
      const cfg = getRuntimeConfig();
      const writeSession = async (agentId, sessionKey, sessionId, extra = {}) => {
        const storePath = resolveStorePath(cfg.session?.store, { agentId });
        await patchSessionEntryCore({ sessionKey, storePath }, () => ({ sessionId,
          updatedAt: now, ...extra }), { fallbackEntry: { sessionId, updatedAt: now } });
        return storePath;
      };
      const parentStorePath = await writeSession('main', binding.parentSessionKey,
        binding.parentSessionId, { bensonDecisionCommitments: [commitment] });
      await writeSession('jessica-vacuum', binding.childSessionKey, 'child-session');
      const append = async (agentId, sessionKey, sessionId, message) => {
        assert.ok(await appendMessage({ agentId, sessionKey, sessionId, message }));
      };
      await append('main', binding.parentSessionKey, binding.parentSessionId,
        { role: 'user', timestamp: now - 2000,
          content: [{ type: 'text', text: 'Please check status' }],
          __openclaw: { senderId: 'oren' } });
      await append('jessica-vacuum', binding.childSessionKey, 'child-session',
        { role: 'assistant', timestamp: now - 800,
          content: [{ type: 'toolCall', id: 'native-call', name: 'jessica_read' }] });
      await append('jessica-vacuum', binding.childSessionKey, 'child-session',
        { role: 'toolResult', timestamp: now - 700, toolName: 'jessica_read',
          toolCallId: 'native-call', content: [{ type: 'text', text: JSON.stringify(domainResult) }] });
      await append('jessica-vacuum', binding.childSessionKey, 'child-session',
        { role: 'assistant', timestamp: now - 600, stopReason: 'stop',
          content: [{ type: 'text', text: malformed ? '{broken' : JSON.stringify(final) }] });
      const prepared = await prepareBensonNativeCompletion({ childRunId: child.runId,
        bensonCompletionBinding: binding });
      if (malformed) {
        assert.equal(prepared.blocked, true);
        const durable = transaction((db) => ({ child: readSubagent(db, child.runId),
          task: readTask(db.db, task.taskId) }));
        assert.equal(durable.task.status, 'failed');
        assert.equal(durable.child.delivery.status, 'suspended');
        assert.equal(durable.child.bensonCompletionAdmission, undefined);
      } else {
        assert.equal(prepared.admission.destination, 'CALLER');
        assert.equal(transaction((db) => readTask(db.db, task.taskId)).status, 'running');
        if (pending) {
          assert.equal(prepared.admission.result.pendingContext.binding.requesterId, 'oren');
          assert.equal(prepared.admission.result.pendingContext.binding.conversationId,
            binding.parentSessionKey);
        }
        const payload = { kind: 'agentTurn', sessionKey: binding.parentSessionKey,
          message: 'native canonical', messageId: 'benson-s07-caller',
          idempotencyKey: 'benson-s07-caller', route: { channel: 'webchat' },
          inputProvenance: { kind: 'inter_session', sourceTool: 'subagent_announce' } };
        const first = admitCaller({ runId: child.runId, payload,
          bensonCompletionAdmission: prepared.admission });
        const second = admitCaller({ runId: child.runId, payload,
          bensonCompletionAdmission: prepared.admission });
        assert.equal(second.reused, true);
        assert.equal(second.id, first.id);
        const persisted = transaction((db) => ({ child: readSubagent(db, child.runId),
          task: readTask(db.db, task.taskId) }));
        assert.equal(persisted.task.status, 'succeeded');
        const queued = { kind: 'agentTurn', id: first.id, owner: {
          kind: 'subagent_completion', runId: child.runId, taskId: task.taskId,
          generation: persisted.child.delivery.generation,
          deadlineAt: persisted.child.delivery.deadlineAt } };
        assert.equal(resolveCorrelated(queued).runtimeContextFragments[1].text,
          JSON.stringify(prepared.admission.result));
        await patchSessionEntryCore({ sessionKey: binding.parentSessionKey,
          storePath: parentStorePath }, () => ({ sessionId: 'replaced', updatedAt: now + 1 }), {});
        assert.throws(() => resolveCorrelated(queued), /owner unavailable/);
      }
    }
    process.stdout.write(`fixture ${kind} PASS\n`);
  }
} else {
  const root = process.env.OPENCLAW_S07_PACKAGE_ROOT ?? mkdtempSync(join(tmpdir(), 'benson-s07-package-'));
  const ownsRoot = !process.env.OPENCLAW_S07_PACKAGE_ROOT;
  const states = [];
  if (ownsRoot) {
    const copy = spawnSync('cp', ['-a', installed + '/.', root], { encoding: 'utf8' });
    assert.equal(copy.status, 0, copy.stderr);
    const installedSource = readFileSync(join(root, 'dist', 'sessions-spawn-tool-AW-VALLJ.mjs'), 'utf8');
    if (!installedSource.includes('const BENSON_COMPLETION_PRODUCTION_ENABLED = false;')) {
      const applied = spawnSync('patch', ['-p1', '-d', root], { input: readFileSync(patch),
        encoding: 'utf8' });
      assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    }
  }
  after(() => {
    for (const state of states) rmSync(state, { recursive: true, force: true });
    if (ownsRoot) rmSync(root, { recursive: true, force: true });
  });
  const spawn = (mode, kind, state) => spawnSync(process.execPath,
    [fileURLToPath(import.meta.url), mode, kind], { encoding: 'utf8',
      env: { ...process.env, OPENCLAW_S07_PACKAGE_ROOT: root, OPENCLAW_STATE_DIR: state } });
  test('host production gate stays disabled and binds only exact native parent identity', async () => {
    const source = readFileSync(join(root, 'dist', 'sessions-spawn-tool-AW-VALLJ.mjs'), 'utf8');
    assert.match(source, /const BENSON_COMPLETION_PRODUCTION_ENABLED = false;/u);
    const extracted = source.match(/async function resolveBensonSpawnBinding\([^]*?\n\}/u)?.[0];
    assert.ok(extracted);
    const build = (activeRunId = 'parent-run', target = 'parent') => vm.runInNewContext(
      `(${extracted.replace(/await import\("file:\/\/\/home\/oa\/projects\/benson\/integrations\/openclaw\/benson-routing\/completion-control\.mjs"\)/u,
        'await Promise.resolve({ bindNativeCompletion: injectedBinder })')})`, {
        BENSON_COMPLETION_PRODUCTION_ENABLED: true, injectedBinder: bindNativeCompletion,
        replyRunRegistry: { getSourceTurnId: () => 'request',
          resolveCurrentMessageInjectionTarget: () => ({ runId: activeRunId }) },
        loadSessionEntryByKey: () => ({ sessionId: 'parent-session',
          bensonDecisionCommitments: [{ requestId: 'request', sessionId: 'parent-session',
            owner: 'main', phase: 'committed' }] }), Error,
      })({ completionTarget: target }, { agentSessionKey: 'agent:main:test',
        requesterTurnRunId: 'parent-run' }, 'main', 'jessica-vacuum');
    const factory = await build();
    assert.equal(factory('child-run', 'agent:jessica-vacuum:subagent:test').callerRunId, 'parent-run');
    await assert.rejects(build('foreign-run'), /exact active parent/);
    await assert.rejects(build('parent-run', 'announce'), /private completion/);
  });
  for (const [label, phases] of [
    ['unprepared', ['fixture', 'direct-worker']],
    ['prepared', ['fixture', 'direct-prepare', 'direct-worker']],
    ['receipt', ['fixture', 'direct-prepare', 'direct-deliver', 'direct-worker']],
  ]) {
    test(`Direct native worker recovers ${label} final after process restart`, () => {
      const state = mkdtempSync(join(tmpdir(), `benson-s09-direct-${label}-`));
      states.push(state);
      for (const mode of phases) {
        const result = spawn(mode, 'direct', state);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, new RegExp(`\\b${mode} direct PASS`));
      }
    });
  }
  for (const kind of ['caller', 'pending', 'malformed', 'direct']) {
    test(`native ${kind} admission, duplicate/recovery, and restart`, () => {
      const state = mkdtempSync(join(tmpdir(), `benson-s07-${kind}-`));
      states.push(state);
      for (const mode of ['fixture', 'restart',
        ...(kind === 'direct' ? ['direct-prepare', 'direct-deliver', 'direct-settle', 'direct-repeat'] : [])]) {
        const result = spawn(mode, kind, state);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, new RegExp(`${mode} ${kind} PASS`));
      }
    });
  }
}
