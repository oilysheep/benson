import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { createResponseEnvelope } from '../envelope.mjs';

const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT ??
  resolve(homedir(), '.npm-global/lib/node_modules/openclaw');
const root = join(packageRoot, 'dist');
const session = await import(pathToFileURL(join(root,
  'session-accessor.sqlite-entry-UCl9kr-O.mjs')).href);
const finalization = await import(pathToFileURL(join(root,
  'dispatch-from-config.finalize-B25V5wMZ.mjs')).href);
const queue = await import(pathToFileURL(join(root,
  'session-delivery-queue.records-rYJIeHGW.mjs')).href);

function envelope(requestId, sourceType, text, language = 'he') {
  return createResponseEnvelope({ messageCandidate: { text, language } }, {
    requestId,
    source: { type: sourceType, agentId: sourceType === 'main' ? 'main' :
      'jessica-vacuum', runId: `run-${requestId}` },
    results: [], status: sourceType === 'main' ? 'success' : 'failure',
    pendingContext: null,
    responsePolicy: sourceType === 'main' ? {
      allowedModes: ['pass_through', 'safe_failure'], preferredMode: 'pass_through',
    } : { allowedModes: ['safe_failure'], preferredMode: 'safe_failure' },
    provenance: { executionVerified: sourceType === 'main' ? 'not_applicable' : false,
      completionCorrelated: false },
    lifecycle: sourceType === 'main' ? { domainExecution: 'none', failure: null } :
      { domainExecution: 'uncertain', failure: { code: 'RESULT_UNAVAILABLE' } },
  });
}

async function withSession(run) {
  const stateDir = mkdtempSync(join(tmpdir(), 'benson-s09-native-prepared-'));
  const scope = { agentId: 'main', sessionKey: 'agent:main:benson-s09-prepared',
    sessionId: 'benson-s09-prepared-generation',
    storePath: join(stateDir, 'agents', 'main', 'sessions', 'sessions.json'),
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
  try {
    await session.d(scope, () => ({ sessionId: scope.sessionId, updatedAt: Date.now() }), {
      fallbackEntry: { sessionId: scope.sessionId, updatedAt: Date.now() },
      skipMaintenance: true,
    });
    await run(scope);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function input(scope, requestId, sourceType, responseEnvelope, referenceTime) {
  return { scope, queueEntry: queue.B({ sessionKey: scope.sessionKey,
    sessionId: scope.sessionId, requestId, sourceType,
    ...(sourceType === 'direct' ? { sourceRunId: `run-${requestId}`, taskId: `task-${requestId}` } : {}),
    deliveryContext: { channel: 'webchat', to: 'benson-s09-prepared' } }),
  responseEnvelope, referenceTime };
}

test('native final freezes transcript, intent, fallback presentation and replay across midnight',
  async () => withSession(async (scope) => {
    const requestId = 'main-1';
    const responseEnvelope = envelope(requestId, 'main', ' שלום ');
    const first = await finalization.__testPrepareBensonNativeInteractiveFinal(input(
      scope, requestId, 'main', responseEnvelope, Date.parse('2026-09-27T12:00:00Z')));
    assert.equal(first.replayed, false);
    assert.equal(first.text, ' שלום ');
    assert.equal(first.language, 'he');
    assert.equal(first.timezone, 'Asia/Jerusalem');
    const pending = session.l(scope).bensonPendingFinals[0];
    assert.equal(pending.intentId, first.intentId);
    assert.equal(pending.text, first.text);
    assert.equal(pending.bensonFinal.transcriptMessageId, first.transcriptMessageId);
    assert.equal(pending.bensonFinal.referenceTime, '2026-09-27T12:00:00.000Z');
    const second = await finalization.__testPrepareBensonNativeInteractiveFinal({
      ...input(scope, requestId, 'main', responseEnvelope, Date.parse('2026-09-28T12:00:00Z')),
      preferences: { explicitLanguage: 'en', explicitTimezone: 'UTC' },
    });
    assert.equal(second.replayed, true);
    assert.deepEqual({ text: second.text, language: second.language,
      timezone: second.timezone, referenceTime: second.referenceTime },
    { text: first.text, language: first.language, timezone: first.timezone,
      referenceTime: first.referenceTime });
    assert.equal(session.l(scope).bensonPendingFinals[0].deliveries[0].state, 'prepared');
    const delivered = await finalization.B({ queueEntry: input(scope, requestId,
      'main', responseEnvelope, Date.now()).queueEntry, scope });
    assert.equal(delivered.status, 'delivered');
    assert.deepEqual(delivered.receipt, { kind: 'webchat',
      transcriptMessageId: first.transcriptMessageId });
    assert.equal(session.l(scope).bensonPendingFinals[0].deliveries[0].state, 'delivered');
    const again = await finalization.B({ queueEntry: input(scope, requestId,
      'main', responseEnvelope, Date.now()).queueEntry, scope });
    assert.deepEqual(again, delivered);
  }));

test('native final rejects contradictory retry, competing admission and changed recipient',
  async () => withSession(async (scope) => {
    const original = input(scope, 'direct-1', 'main',
      envelope('direct-1', 'main', 'untrusted agent prose'), Date.now());
    const first = await finalization.__testPrepareBensonNativeInteractiveFinal(original);
    assert.equal(first.text, 'untrusted agent prose');
    await assert.rejects(() => finalization.__testPrepareBensonNativeInteractiveFinal({
      ...original, responseEnvelope: envelope('direct-1', 'main', 'other'),
    }), /contradicts prepared intent/u);
    await assert.rejects(() => finalization.__testPrepareBensonNativeInteractiveFinal({
      ...original, queueEntry: { ...original.queueEntry,
        deliveryContext: { channel: 'webchat', to: 'another-recipient' } },
    }), /contradicts prepared intent/u);
    const second = await finalization.__testPrepareBensonNativeInteractiveFinal(input(
      scope, 'direct-2', 'main', envelope('direct-2', 'main', 'another'), Date.now()));
    assert.notEqual(second.intentId, first.intentId);
    assert.deepEqual(session.l(scope).bensonPendingFinals.map((item) => item.intentId),
      [first.intentId, second.intentId]);
  }));

test('concurrent distinct admissions retain both final intents in one native session',
  async () => withSession(async (scope) => {
    const [a, b] = await Promise.all(['parallel-a', 'parallel-b'].map((requestId) =>
      finalization.__testPrepareBensonNativeInteractiveFinal(input(scope, requestId,
        'main', envelope(requestId, 'main', `Final ${requestId}`, 'en'), Date.now()))));
    assert.notEqual(a.intentId, b.intentId);
    assert.deepEqual(new Set(session.l(scope).bensonPendingFinals.map((item) => item.intentId)),
      new Set([a.intentId, b.intentId]));
  }));

test('native session replacement preserves prior final intent and rejects rewriting it',
  async () => withSession(async (scope) => {
    const requestId = 'replacement-a';
    const first = await finalization.__testPrepareBensonNativeInteractiveFinal(input(scope,
      requestId, 'main', envelope(requestId, 'main', 'Final A', 'en'), Date.now()));
    await session.d(scope, () => ({ sessionId: 'replacement-generation',
      updatedAt: Date.now() }), { skipMaintenance: true });
    assert.equal(session.l(scope).bensonPendingFinals[0].intentId, first.intentId);
    await assert.rejects(() => session.d(scope, () => ({
      bensonPendingFinals: [], updatedAt: Date.now(),
    }), { skipMaintenance: true }), /cannot be removed or rewritten/u);
    assert.equal(session.l(scope).bensonPendingFinals[0].intentId, first.intentId);
  }));

test('one native queue identity binds the original recipient and admission', () => {
  const base = { sessionKey: 'agent:main:queue-test', sessionId: 'generation-one',
    requestId: 'turn-a', sourceType: 'direct', sourceRunId: 'run-turn-a', taskId: 'task-turn-a',
    deliveryContext: { channel: 'telegram', to: 'chat-1', accountId: 'account-1',
      threadId: 'thread-1' } };
  const prepare = queue.B;
  const first = prepare(base, 100);
  const retry = prepare(base, 200);
  assert.equal(first.id, retry.id);
  assert.equal(first.kind, 'interactiveFinal');
  assert.equal(first.phase, 'awaiting');
  assert.deepEqual(first.deliveryContext, base.deliveryContext);
  assert.notEqual(first.id, prepare({ ...base, requestId: 'turn-b',
    sourceRunId: 'run-turn-b', taskId: 'task-turn-b' }, 100).id);
  assert.throws(() => prepare({ ...base, deliveryContext: null }, 100),
    /admission invalid/u);
});

const finalSource = readFileSync(join(root, 'dispatch-from-config.finalize-B25V5wMZ.mjs'), 'utf8');
function extractedNativeFunction(name, dependencies) {
  const start = finalSource.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} missing`);
  const end = finalSource.indexOf('\n}', start);
  assert.ok(end > start, `${name} end missing`);
  return new vm.Script(`(${finalSource.slice(start, end + 2)})`).runInNewContext(dependencies);
}
function nativeExternalDelivery(send) {
  const settle = extractedNativeFunction('settleBensonNativeFinal', {
    patchSessionEntryCore: session.d,
  });
  return extractedNativeFunction('deliverBensonNativeInteractiveFinal', {
    prepareBensonInteractiveFinalAdmission: queue.B,
    normalizeDeliveryContext: (context) => context,
    loadSessionEntryReadOnly: session.l,
    bensonFinalDigest: (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    settleBensonNativeFinal: settle,
    routeReply: send,
  });
}
test('external native final uses original account/thread and identified provider receipt',
  async () => withSession(async (scope) => {
    const requestId = 'external-receipt';
    const entry = { ...input(scope, requestId, 'main',
      envelope(requestId, 'main', 'Final'), Date.now()) };
    entry.queueEntry = queue.B({ sessionKey: scope.sessionKey,
      sessionId: scope.sessionId, requestId, sourceType: 'main',
      deliveryContext: { channel: 'telegram', to: 'chat-1',
        accountId: 'account-1', threadId: 'thread-1' } });
    await finalization.__testPrepareBensonNativeInteractiveFinal(entry);
    let sends = 0;
    const deliver = nativeExternalDelivery(async (outgoing) => {
      sends++;
      assert.equal(outgoing.to, 'chat-1');
      assert.equal(outgoing.accountId, 'account-1');
      assert.equal(outgoing.threadId, 'thread-1');
      assert.equal(outgoing.mirror, false);
      return { ok: true, delivered: true, ambiguous: false, messageId: 'provider-msg-42' };
    });
    const first = await deliver({ queueEntry: entry.queueEntry, scope, cfg: {} });
    assert.equal(first.status, 'delivered');
    assert.equal(first.receipt.platformMessageId, 'provider-msg-42');
    assert.equal(session.l(scope).bensonPendingFinals[0].bensonReceipt.threadId, 'thread-1');
    const retry = await deliver({ queueEntry: entry.queueEntry, scope, cfg: {} });
    assert.equal(retry.status, 'delivered');
    assert.equal(sends, 1);
  }));
test('external unknown send remains recovery-owned and never resends',
  async () => withSession(async (scope) => {
    const requestId = 'external-unknown';
    const entry = { ...input(scope, requestId, 'main',
      envelope(requestId, 'main', 'Final'), Date.now()) };
    entry.queueEntry = queue.B({ sessionKey: scope.sessionKey,
      sessionId: scope.sessionId, requestId, sourceType: 'main',
      deliveryContext: { channel: 'telegram', to: 'chat-2' } });
    await finalization.__testPrepareBensonNativeInteractiveFinal(entry);
    let sends = 0;
    const deliver = nativeExternalDelivery(async () => { sends++; throw Error('unknown send'); });
    const first = await deliver({ queueEntry: entry.queueEntry, scope, cfg: {} });
    assert.equal(first.status, 'recovery_owned');
    assert.equal(first.reason, 'send_outcome_unknown');
    const retry = await deliver({ queueEntry: entry.queueEntry, scope, cfg: {} });
    assert.equal(retry.reason, 'unknown');
    assert.equal(sends, 1);
    assert.equal(session.l(scope).bensonPendingFinals[0].deliveries[0].state, 'unknown');
  }));
