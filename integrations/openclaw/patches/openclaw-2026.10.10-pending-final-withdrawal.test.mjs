import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createPendingFinalWithdrawalAuthority } from '../../../.checkpoints/domain-run-g1b-g2-20261109/cancellation-recovery-20261121-Yr1DET/prepare.mjs';

// Version-pinned native reducers/actor phase and host entry are evaluated with
// inert dependencies. SQLite fixtures contain only synthetic values. No installed
// module is imported and no native store, configuration, channel or network opens.
const root = process.env.BENSON_WITHDRAWAL_CANDIDATE;
assert(root, 'Supply the isolated native candidate directory');
const native = '/home/oa/.npm-global/lib/node_modules/openclaw/dist';
const hash = value => createHash('sha256').update(value).digest('hex');
const owner = fs.readFileSync(path.join(root, 'dist/session-actor-memory-owner-C3pnd6d2.mjs'), 'utf8');
const completion = fs.readFileSync(path.join(root, 'dist/delivery-completion-Cd30DITK.mjs'), 'utf8');
function functions(source, names) {
  // Pinned bundle functions close at column zero; do not rewrite their bodies.
  const selected = [];
  for (const match of source.matchAll(/^(?:async )?function ([A-Za-z_$][\w$]*)\(/gm)) {
    if (names && !names.includes(match[1])) continue;
    const end = source.indexOf('\n}', match.index);
    assert(end >= 0, 'Incomplete pinned function');
    selected.push(source.slice(match.index, end + 2));
  }
  return selected.join('\n');
}
const names = ['projectSessionEntryPatch', 'reduceSessionEntryPatch', 'mergeSessionEntryPatch',
  'projectPendingFinalDeliveryState', 'projectPendingFinalDeliverySettlement',
  'projectPendingFinalWithdrawal', 'applySessionActorPhaseWithBackend'];
const pure = functions(owner, names) + '\n' + functions(fs.readFileSync(native + '/types-BGDhC4_W.mjs', 'utf8')) + '\n' +
  functions(fs.readFileSync(native + '/session-entry-lineage-B7Mubzwj.mjs', 'utf8'));
const context = {
  structuredClone, isDeepStrictEqual: (a, b) => isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))), Date, sha256Hex: hash,
  normalizeOptionalString: x => typeof x === 'string' ? x.trim() || undefined : undefined,
  asNonNegativeFiniteNumber: x => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined,
  SessionActorStaleStateError: class extends Error {},
  // A withdrawal must never create terminal delivery evidence or recovery claims.
  mergeRestartRecoveryTerminalDeliveryEvidence: () => { throw Error('Unexpected delivery receipt'); },
  buildRestartRecoveryClaimCleanupPatch: () => { throw Error('Unexpected recovery claim'); }
};
const phase = vm.runInNewContext(pure + '\napplySessionActorPhaseWithBackend;', context, { timeout: 2000 });
const clone = x => JSON.parse(JSON.stringify(x));
function fixture(count = 1) {
  const entry = {
    sessionId: 'synthetic-main-session', lifecycleRevision: 'synthetic-lifecycle', updatedAt: 100,
    status: 'done', abortedLastRun: false, lastRunId: 'synthetic-main-run',
    pendingFinalDelivery: {
      kind: 'replayable', createdAt: 100, sourceRunId: 'synthetic-main-run', intentId: 'synthetic-final',
      text: 'Synthetic retained final', context: { channel: 'whatsapp', to: 'synthetic-recipient', accountId: 'synthetic-account' },
      deliveries: Array.from({ length: count }, (_, i) => ({ id: 'synthetic-member-' + i, state: 'prepared' }))
    }
  };
  const pending = entry.pendingFinalDelivery;
  const facts = {
    status: 'RETAINED_PRIVATE_PENDING_FACTS_NOT_CURRENT_NATIVE_ADMISSION',
    entrySha256: hash(JSON.stringify(entry)), sessionIdSha256: hash(entry.sessionId),
    pending: { intentIdSha256: hash(pending.intentId), sourceRunIdSha256: hash(pending.sourceRunId), textSha256: hash(pending.text),
      channel: pending.context.channel, toSha256: hash(pending.context.to), accountIdSha256: hash(pending.context.accountId),
      deliveries: pending.deliveries.map(d => ({ idSha256: hash(d.id) })) }
  };
  const expected = {
    entrySha256: facts.entrySha256, sessionIdSha256: facts.sessionIdSha256,
    intentIdSha256: facts.pending.intentIdSha256, sourceRunIdSha256: facts.pending.sourceRunIdSha256,
    textSha256: facts.pending.textSha256, channel: facts.pending.channel,
    toSha256: facts.pending.toSha256, accountIdSha256: facts.pending.accountIdSha256,
    deliveryIdSha256s: facts.pending.deliveries.map(d => d.idSha256)
  };
  const scope = { agentId: 'main', sessionKeySha256: hash('agent:main:main'), databasePathSha256: hash('/synthetic/main.sqlite'), stateDirSha256: hash('/synthetic') };
  const decision = { version: 1, action: 'withdraw-permanently', operationalAuthority: false, scope, expected };
  const decisionSha256 = hash(JSON.stringify(decision));
  const authorization = { version: 1, action: 'withdraw-permanently', decisionSha256, scope, expected };
  const grant = { status: 'APPROVED_ONE_USE_WITHDRAWAL', authorization, maximumCalls: 1, gatewayActivation: false, outbound: false, expiresAt: Date.now() + 60000 };
  return { entry, facts, decision, decisionSha256, authorization, grant };
}
function permit(f, overrides = {}) {
  return createPendingFinalWithdrawalAuthority({ facts: f.facts, decision: f.decision, decisionSha256: f.decisionSha256,
    operationalGrant: f.grant, assertStoppedCurrent: () => {}, ...overrides });
}
function database(entry, { failAudit = false, failWrite = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'benson-withdrawal-fixture-'));
  const file = path.join(dir, 'fixture.sqlite');
  let db = new DatabaseSync(file);
  db.exec('CREATE TABLE entries (id INTEGER PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE events (id TEXT PRIMARY KEY, json TEXT NOT NULL)');
  db.prepare('INSERT INTO entries VALUES (1, ?)').run(JSON.stringify(entry));
  db.prepare('INSERT INTO events VALUES (?, ?)').run('original', JSON.stringify({ type: 'message', id: 'original', message: { role: 'assistant', content: entry.pendingFinalDelivery.text } }));
  let commands = 0;
  const current = () => JSON.parse(db.prepare('SELECT json FROM entries WHERE id=1').get().json);
  const events = () => db.prepare('SELECT json FROM events ORDER BY rowid').all().map(r => JSON.parse(r.json));
  function command(input, authority = { authorize() {} }) {
    commands++;
    db.exec('BEGIN IMMEDIATE');
    const hot = { target: { sessionKey: 'agent:main:main' }, entry: current() };
    try {
      const outcome = phase({ type: 'session.actor.deliverySettled', input }, hot, {
        agentId: 'main',
        admit: () => authority.authorize(),
        appendEvent: ({ eventJson }) => {
          if (failAudit) throw Error('Synthetic audit refusal');
          const event = JSON.parse(eventJson);
          db.prepare('INSERT INTO events VALUES (?, ?)').run(event.id, eventJson);
          return { appended: true, projectionNeedsReconcile: false };
        },
        writeEntry: next => {
          db.prepare('UPDATE entries SET json=? WHERE id=1').run(JSON.stringify(next));
          if (failWrite) throw Error('Synthetic writer refusal');
          hot.entry = next;
        }
      });
      db.exec('COMMIT');
      return { kind: 'committed', value: clone(outcome.value) };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return { current, events, command, commands: () => commands,
    reopen: () => { db.close(); db = new DatabaseSync(file); }, close: () => { db.close(); fs.rmSync(dir, { recursive: true }); } };
}
function host(f, db, { owners = [null], unknown = false, stale = false, nativeOutcome } = {}) {
  const p = permit(f); let commands = 0, acquisitions = 0;
  const entry = functions(completion, ['withdrawPendingFinalDelivery']);
  const api = vm.runInNewContext(entry + '\n typeof withdrawPendingFinalDelivery === "function" ? withdrawPendingFinalDelivery : undefined;', {
    structuredClone, Date, randomUUID, createHash,
    SqliteWorkerError: class extends Error { constructor(message, code) { super(message); this.code = code; } },
    withSessionActor: async (_scope, lifetime, consume) => {
      acquisitions++; lifetime.assertCurrent();
      return consume({
        target: { database: { kind: 'file', nativeLocation: '/synthetic/main.sqlite' }, sessionKey: 'agent:main:main' },
        read: async () => ({ entry: db.current(), version: { generation: 'fixture-generation', revision: 1 } }),
        deliverySettled: async (input, authority) => {
          commands++;
          assert.deepEqual(input.expected, { generation: 'fixture-generation', revision: 1 });
          if (nativeOutcome) return nativeOutcome(input, authority);
          if (stale) return { kind: 'stale-version' };
          const outcome = db.command(input, authority);
          return unknown ? { kind: 'unknown' } : outcome;
        }
      });
    },
    findDeliveryIntentOwners: async () => owners
  });
  return { api: overrides => api({ agentId: 'main', sessionKey: 'agent:main:main', storePath: '/synthetic/main.sqlite', stateDir: '/synthetic', ...p, ...overrides }),
    commands: () => commands, acquisitions: () => acquisitions };
}

// Execute the pinned durable producer's actual pre-entry transport-failure path.
// The transport is inert: no installed module, worker or native SQLite is opened.
async function durableRefusal(message) {
  let calls = 0, invalidations = 0;
  const source = fs.readFileSync(native + '/session-actor-durable-BcxBXS2b.mjs', 'utf8');
  const create = vm.runInNewContext(functions(source, ['errorFacts', 'createSqliteSessionActorExecutor']) + '\ncreateSqliteSessionActorExecutor;', {
    Error, createSqliteWorkerTransferCollector: () => ({}),
    hasSqliteWorkerOutcomeUnknown: error => { assert.equal(error.code, undefined); return false; }
  });
  const actor = create({ target: { database: { kind: 'file' }, sessionKey: 'synthetic' },
    transport: { run: async () => { calls++; throw Error(message); } },
    replica: { invalidate: () => invalidations++ }
  });
  const outcome = await actor.command('deliverySettled', { commandId: 'synthetic-command' }, {});
  assert.equal(calls, 1); assert.equal(invalidations, 1);
  return outcome;
}

test('noncommitted durable outcome survives the retained closure projection without raw error disclosure', async () => {
  const cases = [
    [await durableRefusal('Session actor admission belongs to another target'),
      { kind: 'rolled-back', errorName: 'Error', reason: 'actor-admission-target-mismatch' }, 'unavailable'],
    [await durableRefusal('Pending final withdrawal refused: authority or custody changed'),
      { kind: 'rolled-back', errorName: 'Error', reason: 'withdrawal-authority-or-custody-changed' }, 'unavailable'],
    [{ kind: 'stale-version' }, { kind: 'stale-version', errorName: 'absent', reason: 'absent' }, 'unavailable'],
    [{ kind: 'unknown', error: { name: 'SqliteWorkerError', message: 'Unconfirmed actor settlement' } },
      { kind: 'unknown', errorName: 'SqliteWorkerError', reason: 'actor-settlement-unconfirmed' }, 'outcome-unknown'],
    [await durableRefusal('SECRET-session-recipient-token\r\nFORGED-PASS'),
      { kind: 'rolled-back', errorName: 'Error', reason: 'unrecognized' }, 'unavailable'],
    [{ kind: 'SECRET-kind', error: { name: 'SECRET-name\r\nFORGED-PASS', message: 'SECRET-message', code: 'SECRET-code', stack: 'SECRET-stack' }, target: 'SECRET-target' },
      { kind: 'unrecognized', errorName: 'unrecognized', reason: 'unrecognized' }, 'unavailable']
  ];
  for (const [outcome, expected, code] of cases) {
    const f = fixture(), db = database(f.entry), h = host(f, db, { nativeOutcome: () => outcome });
    try {
      await assert.rejects(h.api(), error => {
        // Exact existing runner projection: message is retained only up to LF.
        const receipt = JSON.parse(JSON.stringify({ errorType: error.name, code: error.code ?? null,
          message: String(error.message).split('\n')[0] }));
        assert.equal(receipt.code, code);
        assert.match(receipt.message, /^Withdrawal not confirmed; reconcile native custody and audit without retry; evidence=/);
        assert.deepEqual(JSON.parse(receipt.message.split('; evidence=')[1]), expected);
        assert.doesNotMatch(JSON.stringify(receipt), /SECRET|FORGED|\\r|\\n/);
        return true;
      });
      await assert.rejects(h.api(), /already consumed/);
      assert.equal(h.commands(), 1); assert.equal(h.acquisitions(), 1);
      assert.deepEqual(db.current(), f.entry); assert.equal(db.events().length, 1);
    } finally { db.close(); }
  }
});

test('withdrawal atomically retains terminal suppression audit and releases native custody', () => {
  const f = fixture(3), db = database(f.entry);
  try {
    const result = db.command({ withdrawal: { authorization: f.authorization, now: Date.now() } });
    assert.equal(result.value.state, 'suppressed'); assert.equal(result.value.wakeRecovery, false);
    db.reopen();
    assert.equal(db.current().pendingFinalDelivery, undefined); assert.equal(db.current().status, 'done');
    const events = db.events(); assert.equal(events.length, 2); assert.equal(events[0].id, 'original');
    const audit = events[1]; assert.equal(audit.type, 'custom'); assert.equal(audit.customType, 'openclaw.pending-final-withdrawal');
    assert.equal(audit.data.historicalDeliveryOutcome, 'unknown'); assert.equal(audit.data.deliveries.length, 3);
    assert(audit.data.deliveries.every(d => d.state === 'suppressed' && d.previousState === 'prepared' && !d.receipt));
    assert.deepEqual(audit.data.authorization, f.authorization); assert.equal(audit.id, result.value.withdrawalAuditId);
  } finally { db.close(); }
});

test('exact identity, currentness, version and custody negatives leave state and history unchanged', () => {
  const changes = [
    f => f.authorization.version = 2, f => f.authorization.action = 'deliver',
    f => f.authorization.scope.agentId = 'foreign', f => f.authorization.scope.sessionKeySha256 = '0'.repeat(64),
    ...['entrySha256','sessionIdSha256','intentIdSha256','sourceRunIdSha256','textSha256','toSha256','accountIdSha256'].map(key => f => f.authorization.expected[key] = '0'.repeat(64)),
    f => f.authorization.expected.deliveryIdSha256s = ['0'.repeat(64)],
    f => f.entry.updatedAt++, f => f.entry.status = 'running', f => f.entry.abortedLastRun = true,
    f => f.entry.mainRestartRecovery = { cycleId: 'foreign' }, f => f.entry.restartRecoveryDeliveryRunId = 'foreign',
    f => f.entry.pendingDeliveryNotice = { state: 'owed' },
    f => f.entry.pendingFinalDelivery.deliveries[0].state = 'queued',
    f => f.entry.pendingFinalDelivery.deliveries[0].receipt = { platformMessageId: 'synthetic' }
  ];
  for (const change of changes) {
    const f = fixture(); change(f); const db = database(f.entry), before = db.current();
    try { assert.throws(() => db.command({ withdrawal: { authorization: f.authorization, now: Date.now() } })); assert.deepEqual(db.current(), before); assert.equal(db.events().length, 1); }
    finally { db.close(); }
  }
});

test('an exact hash cannot authorize active, unknown or already-owned native state', () => {
  for (const change of [e => e.status = 'running', e => e.abortedLastRun = true,
    e => e.pendingFinalDelivery.deliveries[0].state = 'unknown', e => e.pendingFinalDelivery.deliveries[0].state = 'queued',
    e => e.pendingFinalDelivery.deliveries[0].receipt = { platformMessageId: 'synthetic' },
    e => e.mainRestartRecovery = { cycleId: 'synthetic-recovery' }]) {
    const f = fixture(); change(f.entry); f.authorization.expected.entrySha256 = hash(JSON.stringify(f.entry));
    const db = database(f.entry);
    try { assert.throws(() => db.command({ withdrawal: { authorization: f.authorization, now: Date.now() } }), /withdrawal refused/); assert.deepEqual(db.current(), f.entry); assert.equal(db.events().length, 1); }
    finally { db.close(); }
  }
});

test('audit, entry-write and authority failures roll back both sides of the native phase', () => {
  for (const mode of ['audit', 'entry', 'authority']) {
    const f = fixture(), db = database(f.entry, { failAudit: mode === 'audit', failWrite: mode === 'entry' });
    try {
      assert.throws(() => db.command({ withdrawal: { authorization: f.authorization, now: Date.now() } }, { authorize() { if (mode === 'authority') throw Error('Synthetic revoked authority'); } }), /Synthetic (audit refusal|writer refusal|revoked authority)/);
      db.reopen(); assert.deepEqual(db.current(), f.entry); assert.equal(db.events().length, 1);
    } finally { db.close(); }
  }
});

test('host entry performs one current native command; no resend, recovery or duplicate withdrawal', async () => {
  const f = fixture(), db = database(f.entry), h = host(f, db);
  try {
    const result = await h.api(); assert.equal(result.state, 'suppressed'); assert.equal(result.historicalDeliveryOutcome, 'unknown');
    assert.equal(h.commands(), 1); assert.equal(h.acquisitions(), 1);
    await assert.rejects(h.api(), /already consumed/); assert.equal(h.commands(), 1); assert.equal(db.events().length, 2);
  } finally { db.close(); }
});

test('native ownership, missing/async authority and stale version fail closed without retry', async () => {
  for (const options of [{ owners: [] }, { owners: [{ status: 'pending' }] }, { owners: [undefined] }, { stale: true }]) {
    const f = fixture(), db = database(f.entry), h = host(f, db, options);
    try { await assert.rejects(h.api()); assert.equal(h.commands(), options.stale ? 1 : 0); assert.deepEqual(db.current(), f.entry); assert.equal(db.events().length, 1); }
    finally { db.close(); }
  }
  for (const authority of [undefined, { kind: 'host', assertCurrent: () => Promise.resolve(), authorizeWithdrawal() {}, beginWithdrawal() {} }]) {
    const f = fixture(), db = database(f.entry), h = host(f, db);
    try { await assert.rejects(h.api({ authority })); assert.equal(h.acquisitions(), 0); assert.equal(h.commands(), 0); }
    finally { db.close(); }
  }
});

test('host binds exact agent, session, state root and physical database owner', async () => {
  for (const override of [{ agentId: 'foreign' }, { sessionKey: 'foreign' }, { stateDir: '/foreign' }]) {
    const f = fixture(), db = database(f.entry), h = host(f, db);
    try { await assert.rejects(h.api(override), /scope differs/); assert.equal(h.commands(), 0); assert.equal(h.acquisitions(), 0); }
    finally { db.close(); }
  }
  const f = fixture(); f.decision.scope.databasePathSha256 = '0'.repeat(64);
  f.authorization.scope.databasePathSha256 = '0'.repeat(64); f.decisionSha256 = hash(JSON.stringify(f.decision));
  f.authorization.decisionSha256 = f.decisionSha256;
  const db = database(f.entry), h = host(f, db);
  try { await assert.rejects(h.api(), /physical native owner/); assert.equal(h.commands(), 0); }
  finally { db.close(); }
});

test('unknown commit is not PASS and cannot be blindly replayed; retained audit supports reconciliation', async () => {
  const f = fixture(), db = database(f.entry), h = host(f, db, { unknown: true });
  try {
    await assert.rejects(h.api(), error => error.code === 'outcome-unknown');
    db.reopen(); assert.equal(db.current().pendingFinalDelivery, undefined); assert.equal(db.events().length, 2);
    await assert.rejects(h.api(), /already consumed/); assert.equal(h.commands(), 1);
    const fresh = host(f, db); await assert.rejects(fresh.api(), /No current pending final/); assert.equal(fresh.commands(), 0); assert.equal(db.events().length, 2);
  } finally { db.close(); }
});

test('existing preparation requires separate exact operational grant, stopped state and unexpired one-use authority', () => {
  const f = fixture();
  assert.throws(() => permit(f, { operationalGrant: undefined }));
  assert.throws(() => permit(f, { decision: { ...f.decision, expected: {} } }));
  for (const mutate of [g => g.outbound = true, g => g.maximumCalls = 2, g => g.authorization.expected.intentIdSha256 = '0'.repeat(64)]) {
    const grant = structuredClone(f.grant); mutate(grant); assert.throws(() => permit(f, { operationalGrant: grant }));
  }
  const expired = permit(f, { now: () => f.grant.expiresAt + 1 }); assert.throws(() => expired.authority.assertCurrent());
  const unsafe = permit(f, { assertStoppedCurrent: () => { throw Error('Gateway not stopped'); } }); assert.throws(() => unsafe.authority.assertCurrent());
  const p = permit(f); p.authority.beginWithdrawal(p.authorization); assert.throws(() => p.authority.beginWithdrawal(p.authorization));
});

test('ordinary native prepared-to-queued settlement remains separate from explicit withdrawal', () => {
  const f = fixture(), db = database(f.entry), p = f.entry.pendingFinalDelivery;
  try {
    const result = db.command({ settlement: { sessionId: f.entry.sessionId, intentId: p.intentId, deliveryId: p.deliveries[0].id, state: 'queued', expectedStates: ['prepared'] } });
    assert.equal(result.value.state, 'queued'); assert.equal(db.current().pendingFinalDelivery.deliveries[0].state, 'queued'); assert.equal(db.events().length, 1);
  } finally { db.close(); }
});
