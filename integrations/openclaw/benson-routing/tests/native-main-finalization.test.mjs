import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT ??
  resolve(homedir(), '.npm-global/lib/node_modules/openclaw');
const root = join(packageRoot, 'dist');
const source = readFileSync(join(root, 'dispatch-from-config-Cu599NRF.mjs'), 'utf8');
const scenario = process.argv[2];
const sessionKey = 'agent:main:benson-s09-main';
const sessionId = 'main-generation-one';
const requestId = 'main-request-one';
const route = { channel: 'webchat', to: 'benson-s09-main' };

function nativeFunction(name, context) {
  const body = source.match(new RegExp(`async function ${name}\\([^]*?\\n\\}`, 'u'))?.[0];
  assert.ok(body, `${name} missing`);
  const isolated = body.replace(
    'await import("file:///home/oa/projects/benson/integrations/openclaw/benson-routing/envelope.mjs")',
    'await Promise.resolve({ createMainResponseEnvelope: injectedEnvelope })',
  ).replace('await import("./dispatch-from-config.finalize-B25V5wMZ.mjs")',
    'await Promise.resolve({ C: injectedPrepareFinal })');
  const script = new vm.Script(`(${isolated})`);
  return script.runInNewContext(context);
}

if (scenario) {
  const [{ d: patchSession, l: loadSession }, { c: transaction },
    { ut: loadQueue }, { t: queueName, B: prepareQueue },
    { t: captureContext }, { B: admitQueue }, { L: scheduleQueue },
    { f: listChildren }, { t: deliverQueued }] = await Promise.all([
    import(pathToFileURL(join(root, 'session-accessor.sqlite-entry-UCl9kr-O.mjs')).href),
    import(pathToFileURL(join(root, 'openclaw-state-db-BFK9cMiV.mjs')).href),
    import(pathToFileURL(join(root, 'openclaw-state-db-read-connection-Beg0AZE7.mjs')).href),
    import(pathToFileURL(join(root, 'session-delivery-queue.records-rYJIeHGW.mjs')).href),
    import(pathToFileURL(join(root, 'openclaw-state-worker-context-Dn3_Z_Oi.mjs')).href),
    import(pathToFileURL(join(root, 'session-delivery-queue-storage-DSTuGS2l.mjs')).href),
    import(pathToFileURL(join(root, 'subagent-completion-admission.store-Bw0OSK2O.mjs')).href),
    import(pathToFileURL(join(root, 'subagent-registry-read-C2SIiLpb.mjs')).href),
    import(pathToFileURL(join(root, 'server-restart-sentinel-Bc_R9rEL.mjs')).href),
  ]);
  const scope = { agentId: 'main', sessionKey, sessionId,
    storePath: join(process.env.OPENCLAW_STATE_DIR, 'agents', 'main', 'sessions', 'sessions.json'),
    env: { ...process.env } };
  const queueEntry = prepareQueue({ sessionKey, sessionId, requestId,
    sourceType: 'main', deliveryContext: route });
  if (scenario.startsWith('prepare') || scenario === 'admit-only') {
    await patchSession(scope, () => ({ sessionId, updatedAt: Date.now() }),
      { fallbackEntry: { sessionId, updatedAt: Date.now() } });
    const operation = {};
    const state = {
      bensonRequestAdmission: { kind: 'candidate', requestId, sessionKey },
      operationSessionStoreEntry: { sessionKey, storePath: scope.storePath,
        entry: { sessionId } },
      ctx: { OriginatingChannel: route.channel, OriginatingTo: route.to },
      cfg: {}, getDispatchReplyOperation: () => operation,
      isDispatchOperationAborted: () => false,
      markInboundDedupeReplayUnsafe() {},
      turnLedger: { setBensonManaged() {} },
      getAgentRunId: () => 'native-main-run-one',
      getAgentRunTerminalOutcome: () => 'completed',
      replyOperationRunState: { backgroundWorkStarted: false },
      bensonObservedToolWork: false,
      replyResult: scenario === 'prepare-failure'
        ? [{ text: 'The operation succeeded', isError: true }]
        : [{ text: 'שלום', isError: false }],
      dispatcher: { getQueuedCounts: () => ({ final: 0 }) },
      commitInboundDedupeIfClaimed() {}, recordProcessed() {}, markIdle() {},
      completeDispatchReplyOperation() {}, attachSourceReplyDeliveryMode: (result) => result,
    };
    const commit = nativeFunction('commitBensonNativeOwner', {
      patchSessionEntryCore: patchSession, DispatchReplyOperationAbortedError: class extends Error {},
    });
    const admit = nativeFunction('admitBensonNativeFinalAtMainBoundary', {
      prepareBensonInteractiveFinalAdmission: prepareQueue,
      captureOpenClawStateWorkerContext: captureContext,
      admitBensonInteractiveFinal: admitQueue,
    });
    state.bensonManagedFinal = await admit(state);
    assert.equal(state.bensonManagedFinal.status, 'admitted');
    assert.equal(operation.bensonManagedFinal, true);
    assert.deepEqual(loadSession(scope).bensonDecisionCommitments ?? [], []);
    if (scenario === 'admit-only') {
      const queued = transaction((db) => loadQueue(db, queueName, queueEntry.id));
      assert.equal(queued.kind, 'interactiveFinal');
      assert.equal(loadSession(scope).bensonPendingFinals?.length ?? 0, 0);
      process.stdout.write('admit-only PASS\n');
      process.exit(0);
    }
    assert.equal((await commit(state, { route: 'main', eligible: false })).status, 'committed');
    const [{ createMainResponseEnvelope }, { C: prepareFinal }] = await Promise.all([
      import(pathToFileURL(resolve('integrations/openclaw/benson-routing/envelope.mjs')).href),
      import(pathToFileURL(join(root, 'dispatch-from-config.finalize-B25V5wMZ.mjs')).href),
    ]);
    let children = [];
    if (scenario === 'prepare-child' || scenario === 'prepare-partial') {
      const [{ bindNativeCompletion }, { normalizeLegacyTaskResult }] = await Promise.all([
        import(pathToFileURL(resolve('integrations/openclaw/benson-routing/completion-control.mjs')).href),
        import(pathToFileURL(resolve('integrations/openclaw/benson-routing/envelope.mjs')).href),
      ]);
      const corpus = JSON.parse(readFileSync(resolve(
        'integrations/openclaw/benson-routing/tests/fixtures/presentation-cases.json')));
      const raw = corpus.cases.find((item) => item.id === 'jessica-clean-started-he').result;
      const result = normalizeLegacyTaskResult(raw, { taskId: 'main-child-task',
        pendingBinding: null, pendingExpiresAt: null });
      const binding = bindNativeCompletion({
        commitment: { requestId, sessionId, owner: 'main', phase: 'committed' },
        sourceTurnId: requestId, parentSessionKey: sessionKey, parentSessionId: sessionId,
        parentRunId: 'native-main-run-one', childRunId: 'main-child-run-one',
        childSessionKey: 'agent:jessica-vacuum:subagent:main-child-run-one',
        executionOwner: 'jessica-vacuum', completionTarget: 'CALLER',
      });
      children = [{ bensonCompletionBinding: binding, bensonCompletionAdmission: {
        schemaVersion: 1, requestId, childRunId: binding.childRunId,
        taskId: result.taskId, destination: 'CALLER',
        callerRunId: binding.callerRunId, result,
      } }];
      if (scenario === 'prepare-partial') children.push({
        bensonCompletionBinding: { ...binding, childRunId: 'main-child-run-pending' },
        bensonCompletionAdmission: null,
      });
      state.bensonObservedToolWork = true;
    }
    const prepare = nativeFunction('prepareBensonMainDispatchFinal', {
      listSubagentRunsForController: children.length ? () => children : listChildren,
      scheduleSessionDelivery: scheduleQueue,
      injectedEnvelope: (candidate, trusted) => createMainResponseEnvelope(
        structuredClone(candidate), structuredClone(trusted)),
      injectedPrepareFinal: prepareFinal,
    });
    const result = await prepare(state);
    assert.equal(result.status, 'complete');
    const pending = loadSession(scope).bensonPendingFinals;
    assert.equal(pending.length, 1);
    if (scenario === 'prepare-failure') {
      assert.match(pending[0].text, /לא הצלחתי לאמת תוצאה סופית/u);
      assert.equal(pending[0].bensonFinal.policyMode, 'safe_failure');
    } else if (scenario === 'prepare-child') {
      assert.equal(pending[0].bensonFinal.policyMode, 'deterministic');
      assert.ok(pending[0].text.length > 0);
      assert.notEqual(pending[0].text, 'שלום');
    } else if (scenario === 'prepare-partial') {
      assert.equal(pending[0].bensonFinal.policyMode, 'safe_failure');
      assert.match(pending[0].text, /לא הצלחתי לאמת תשובה מלאה/u);
    } else {
      assert.equal(pending[0].text, 'שלום');
      assert.equal(pending[0].bensonFinal.policyMode, 'pass_through');
    }
    assert.equal(pending[0].deliveries[0].state, 'prepared');
    assert.equal(pending[0].bensonFinal.sourceType, 'main');
    const queued = transaction((db) => loadQueue(db, queueName, queueEntry.id));
    assert.equal(queued.id, queueEntry.id);
    assert.equal(queued.deliveryContext.to, route.to);
  } else if (scenario === 'recover-unprepared') {
    const queued = transaction((db) => loadQueue(db, queueName, queueEntry.id));
    await assert.rejects(deliverQueued({ entry: queued, queueContext: {
      admission: { assertCurrent() {} }, environment: { ...process.env },
    } }), /awaits native preparation/u);
    assert.equal(loadSession(scope).bensonPendingFinals?.length ?? 0, 0);
    assert.deepEqual(loadSession(scope).bensonDecisionCommitments ?? [], []);
  } else if (scenario === 'recover') {
    const queued = transaction((db) => loadQueue(db, queueName, queueEntry.id));
    assert.equal(queued.kind, 'interactiveFinal');
    const before = loadSession(scope).bensonPendingFinals[0];
    await deliverQueued({ entry: queued, queueContext: {
      admission: { assertCurrent() {} }, environment: { ...process.env },
    } });
    const after = loadSession(scope).bensonPendingFinals[0];
    assert.equal(after.text, before.text);
    assert.deepEqual(after.bensonFinal, before.bensonFinal);
    assert.equal(after.deliveries[0].state, 'delivered');
    assert.equal(after.bensonReceipt.transcriptMessageId,
      after.bensonFinal.transcriptMessageId);
  } else throw new Error('unknown scenario');
  process.stdout.write(`${scenario} PASS\n`);
} else {
  test('Main native admission prepares one Response Controller final and worker recovers after restart', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'benson-s09-main-final-'));
    try {
      for (const mode of ['prepare', 'recover']) {
        const result = spawnSync(process.execPath,
          [fileURLToPath(import.meta.url), mode], { encoding: 'utf8',
            env: { ...process.env, OPENCLAW_STATE_DIR: stateDir,
              OPENCLAW_PACKAGE_ROOT: packageRoot } });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, new RegExp(`${mode} PASS`));
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
  test('Main reply failure remains an uncertain response-only final after restart', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'benson-s09-main-failure-'));
    try {
      for (const mode of ['prepare-failure', 'recover']) {
        const result = spawnSync(process.execPath,
          [fileURLToPath(import.meta.url), mode], { encoding: 'utf8',
            env: { ...process.env, OPENCLAW_STATE_DIR: stateDir,
              OPENCLAW_PACKAGE_ROOT: packageRoot } });
        assert.equal(result.status, 0, result.stderr || result.stdout);
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
  for (const variant of ['prepare-child', 'prepare-partial']) {
    test('Main CALLER ' + variant + ' result uses the shared final after restart', () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'benson-s09-main-child-'));
      try {
        for (const mode of [variant, 'recover']) {
          const result = spawnSync(process.execPath,
            [fileURLToPath(import.meta.url), mode], { encoding: 'utf8',
              env: { ...process.env, OPENCLAW_STATE_DIR: stateDir,
                OPENCLAW_PACKAGE_ROOT: packageRoot } });
          assert.equal(result.status, 0, result.stderr || result.stdout);
        }
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });
  }
  test('Main queue admission without commitment remains recovery-owned after restart', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'benson-s09-main-unprepared-'));
    try {
      for (const mode of ['admit-only', 'recover-unprepared']) {
        const result = spawnSync(process.execPath,
          [fileURLToPath(import.meta.url), mode], { encoding: 'utf8',
            env: { ...process.env, OPENCLAW_STATE_DIR: stateDir,
              OPENCLAW_PACKAGE_ROOT: packageRoot } });
        assert.equal(result.status, 0, result.stderr || result.stdout);
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
  test('plugin-bound final cannot bypass central native egress after Benson admission', async () => {
    const allowed = source.match(/function isBensonManagedEgressAllowed\([^]*?\n\}/u)?.[0];
    assert.ok(allowed);
    const predicate = new vm.Script(`(${allowed})`).runInNewContext({});
    const start = source.indexOf('const routeReplyOperationToOriginating = async ');
    const end = source.indexOf('\n\t};', start);
    assert.ok(start >= 0 && end > start);
    let routed = false;
    const route = new vm.Script(`(() => { ${source.slice(start, end + 4)}; return routeReplyOperationToOriginating; })()`)
      .runInNewContext({
        state: { bensonManagedFinal: { status: 'admitted' } },
        isBensonManagedEgressAllowed: predicate,
        markInboundDedupeReplayUnsafe: () => { routed = true; },
      });
    assert.equal(await route({ kind: 'payload', payload: { text: 'plugin bypass' } },
      { kind: 'final' }), null);
    assert.equal(routed, false);
  });
  test('active Benson admission vetoes messaging-tool delivery before tool execution', async () => {
    const [{ h: replyRunRegistry }, { x: runBeforeToolCallHook }] = await Promise.all([
      import(pathToFileURL(join(root, 'reply-run-registry.registry-BoHW1D6q.mjs')).href),
      import(pathToFileURL(join(root, 'agent-tools.before-tool-call-D6M7yTR3.mjs')).href),
    ]);
    const key = 'agent:main:benson-s09-tool-egress';
    const operation = replyRunRegistry.begin({ sessionKey: key, sessionId: 'egress-generation' });
    try {
      operation.bensonManagedFinal = true;
      const result = await runBeforeToolCallHook({ toolName: 'message',
        params: { action: 'send', target: 'another-chat', message: 'bypass' },
        ctx: { sessionKey: key, sessionId: 'egress-generation' } });
      assert.equal(result.blocked, true);
      assert.equal(result.deniedReason, 'benson-final-egress');
    } finally {
      operation.complete?.();
    }
  });
}
