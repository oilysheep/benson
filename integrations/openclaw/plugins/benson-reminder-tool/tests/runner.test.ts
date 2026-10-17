import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createReminderTransaction, launchProcessGroup, ReminderProcessError, REMINDER_SERVICE_PATH, type ProcessLauncher } from '../src/runner.js';
import type { ServiceRequest } from '../../../../../agents/reminder-service/lib/schemas.js';
const request: ServiceRequest = { operation: 'pause-reminder', requesterId: 'oren', reminderId: 'r' };
test('fixed executable/argv and whole structured failure survive nonzero exit, without stderr disclosure', async () => {
  let launches = 0;
  const launcher: ProcessLauncher = (executable, argv, events) => {
    launches++; assert.equal(executable, REMINDER_SERVICE_PATH); assert.deepEqual(argv, ['pause-reminder', '--reminder-id', 'r', '--requester', 'oren']);
    queueMicrotask(() => { events.stderr(Buffer.from('private diagnostic')); events.stdout(Buffer.from('{"status":"failure","operation":"pause","error":{"code":"BOUNDED_FAILURE"}}')); events.close(1); });
    return { terminate() {}, hasProcesses() { return false; }, closeStreams() {} };
  };
  const transaction = createReminderTransaction({ launchProcess: launcher });
  const value = await transaction.execute(request, { signal: new AbortController().signal, assertCurrent() {} });
  assert.equal(launches, 1); assert.equal(JSON.stringify(value).includes('private diagnostic'), false);
});
test('abort/timeout/output overflow terminate and wait for close; launched mutation remains uncertain with no retry', async () => {
  for (const reason of ['abort', 'timeout', 'bytes'] as const) {
    const abort = new AbortController(); let launches = 0, closed = false; const signals: string[] = [];
    const launcher: ProcessLauncher = (_executable, _argv, events) => {
      launches++; queueMicrotask(() => { if (reason === 'abort') abort.abort(); if (reason === 'bytes') events.stdout(Buffer.from('😀😀')); });
      return { terminate(signal) { signals.push(signal); queueMicrotask(() => { closed = true; events.close(null); }); }, hasProcesses() { return !closed; }, closeStreams() {} };
    };
    const transaction = createReminderTransaction({ launchProcess: launcher, deadlineMs: 5, maxOutputBytes: reason === 'bytes' ? 6 : 100 });
    await assert.rejects(transaction.execute(request, { signal: abort.signal, assertCurrent() {} }), error => {
      assert.ok(error instanceof ReminderProcessError); assert.equal(error.effects, 'possible'); assert.equal(error.reconciliationRequired, true);
      assert.equal(error.code, reason === 'abort' ? 'REMINDER_ABORTED' : reason === 'timeout' ? 'REMINDER_TIMEOUT' : 'REMINDER_OUTPUT_LIMIT'); return true;
    });
    assert.equal(closed, true); assert.equal(launches, 1); assert.deepEqual(signals, ['SIGTERM']);
  }
});
test('already aborted/stale invocations never launch; malformed/non-object/nonzero success cannot become verified result', async () => {
  const abort = new AbortController(); abort.abort(); let launches = 0;
  const launcher: ProcessLauncher = (_executable, _argv, events) => { launches++; queueMicrotask(() => events.close(0)); return { terminate() {}, hasProcesses() { return false; }, closeStreams() {} }; };
  await assert.rejects(createReminderTransaction({ launchProcess: launcher }).execute(request, { signal: abort.signal, assertCurrent() {} })); assert.equal(launches, 0);
  for (const [json, code] of [['[]', 0], ['malformed', 0], ['{"status":"success"}', 1]] as const) {
    const spawn: ProcessLauncher = (_executable, _argv, events) => { queueMicrotask(() => { events.stderr(Buffer.from('private diagnostic')); events.stdout(Buffer.from(json)); events.close(code); }); return { terminate() {}, hasProcesses() { return false; }, closeStreams() {} }; };
    await assert.rejects(createReminderTransaction({ launchProcess: spawn }).execute(request, { signal: new AbortController().signal, assertCurrent() {} }), error => {
      assert.ok(error instanceof ReminderProcessError); assert.equal(error.code, 'REMINDER_RESULT_INVALID'); assert.equal(error.effects, 'possible'); assert.equal(error.message.includes('private'), false); return true;
    });
  }
});
test('missing close after escalation is bounded and explicitly reports unconfirmed cleanup', async () => {
  const signals: string[] = []; let streamsClosed = false;
  const launcher: ProcessLauncher = () => ({ terminate(signal) { signals.push(signal); }, hasProcesses() { return true; }, closeStreams() { streamsClosed = true; } });
  await assert.rejects(createReminderTransaction({ launchProcess: launcher, deadlineMs: 1 }).execute(request,
    { signal: new AbortController().signal, assertCurrent() {} }), error => {
    assert.ok(error instanceof ReminderProcessError); assert.equal(error.code, 'REMINDER_TIMEOUT'); assert.equal(error.cleanupConfirmed, false);
    assert.equal(error.effects, 'possible'); assert.equal(error.reconciliationRequired, true); return true;
  });
  assert.equal(streamsClosed, true); assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});
test('actual POSIX process group kills a descendant retaining pipes after its wrapper exits', { timeout: 12_000 }, async () => {
  for (const mode of ['pipe', 'ignore']) {
  assert.equal(process.platform, 'linux', 'Target process cleanup proof requires Linux');
  const abort = new AbortController(), pids: number[] = [], signals: string[] = [];
  let output = '';
  const launcher: ProcessLauncher = (_executable, _argv, events) => {
    const child = launchProcessGroup(process.execPath, [fileURLToPath(new URL('./fixtures/process-tree.js', import.meta.url)), mode], {
      ...events, stdout(chunk) {
        output += Buffer.from(chunk).toString('utf8');
        while (output.includes('\n')) {
          const end = output.indexOf('\n'), value: unknown = JSON.parse(output.slice(0, end)); output = output.slice(end + 1);
          assert.ok(typeof value === 'object' && value !== null && 'pid' in value && typeof value.pid === 'number');
          pids.push(value.pid);
        }
        events.stdout(chunk); if (pids.length === 2) abort.abort();
      } });
    return { terminate(signal) { signals.push(signal); child.terminate(signal); }, hasProcesses() { return child.hasProcesses(); }, closeStreams() { child.closeStreams(); } };
  };
  try {
    await assert.rejects(createReminderTransaction({ launchProcess: launcher, deadlineMs: 4_000 }).execute(request,
      { signal: abort.signal, assertCurrent() {} }), error => {
      assert.ok(error instanceof ReminderProcessError); assert.equal(error.code, 'REMINDER_ABORTED'); assert.equal(typeof error.cleanupConfirmed, 'boolean');
      assert.equal(error.effects, 'possible'); assert.equal(error.reconciliationRequired, true); return true;
    });
    assert.equal(pids.length, 2); assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    for (const pid of pids) {
      try { assert.match(await readFile(`/proc/${pid}/stat`, 'utf8'), /^\d+ \(.*\) Z /u, 'No fixture process may remain running'); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    }
  } finally { for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* Fixture already exited. */ } } }
  }
});
