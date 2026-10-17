import { assertInvocationCurrent } from '../../../benson-routing/core/invocation.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { plain } from '../../../benson-routing/core/value.js';
import { ServiceRequestSchema, type ServiceRequest } from '../../../../../agents/reminder-service/lib/schemas.js';
import { decode } from '../../../benson-routing/core/value.js';
import type { InvocationAuthority, ReminderTransaction } from '../../../../../agents/reminder-service/lib/service.js';

export const REMINDER_SERVICE_PATH = fileURLToPath(new URL('../../../../../agents/reminder-service/tools/reminder-service', import.meta.url));
export function buildArgv(raw: unknown): string[] {
  const request = decode(ServiceRequestSchema, raw, 'reminder_process_request_invalid');
  const text = (value: string) => { if (!value.trim()) throw new Error('Reminder process argument empty'); return value.trim(); };
  switch (request.operation) {
    case 'create-intent': return [request.operation, '--input-json', JSON.stringify(request.input)];
    case 'update-reminder':
      if (!['content', 'schedule', 'calendar'].some(key => Object.hasOwn(request.input, key))) throw new Error('Reminder update patch must not be empty');
      return [request.operation, '--reminder-id', text(request.reminderId), '--requester', text(request.requesterId), '--input-json', JSON.stringify(request.input)];
    case 'pause-reminder': case 'resume-reminder': case 'delete-reminder': return [request.operation, '--reminder-id', text(request.reminderId), '--requester', text(request.requesterId)];
    case 'list-reminders': case 'find-reminders': {
      const argv = [request.operation, '--requester', text(request.requesterId)];
      if (request.operation === 'find-reminders') {
        if (request.reminderId !== undefined) argv.push('--reminder-id', text(request.reminderId));
        if (request.jobId !== undefined) argv.push('--job-id', text(request.jobId));
      }
      if (request.recipient !== undefined) argv.push('--recipient', text(request.recipient));
      if (request.operation === 'find-reminders' && request.text !== undefined) argv.push('--text', text(request.text));
      if (request.enabled !== undefined) argv.push('--enabled', request.enabled ? 'true' : 'false');
      return argv;
    }
  }
}
interface ProcessEvents { stdout(chunk: Uint8Array): void; stderr(chunk: Uint8Array): void; error(): void; close(code: number | null): void }
export interface ProcessChild { terminate(signal: 'SIGTERM' | 'SIGKILL'): void; hasProcesses(): boolean; closeStreams(): void }
export type ProcessLauncher = (executable: string, argv: readonly string[], events: ProcessEvents) => ProcessChild;
/** Private POSIX adapter: the wrapper and its descendants belong to this one invocation. */
export const launchProcessGroup: ProcessLauncher = (executable, argv, events) => {
  if (process.platform === 'win32') throw new Error('Reminder process-group cleanup requires POSIX');
  const child = spawn(executable, [...argv], { shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const groupPresent = () => {
    const pid = child.pid;
    if (pid === undefined) return false;
    if (pid <= 1) return true;
    try { process.kill(-pid, 0); return true; }
    catch (error) { return !(error instanceof Error && 'code' in error && error.code === 'ESRCH'); }
  };
  child.stdout.on('data', (chunk: Buffer) => events.stdout(chunk));
  child.stderr.on('data', (chunk: Buffer) => events.stderr(chunk));
  child.once('error', () => events.error()); child.once('close', code => events.close(code));
  return { terminate(signal) {
    const pid = child.pid;
    if (pid === undefined) return;
    if (pid <= 1) { events.error(); return; }
    try { process.kill(-pid, signal); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) events.error(); }
  }, hasProcesses: groupPresent, closeStreams() { child.stdout.destroy(); child.stderr.destroy(); } };
};
export class ReminderProcessError extends Error {
  constructor(readonly code: 'REMINDER_ABORTED' | 'REMINDER_TIMEOUT' | 'REMINDER_OUTPUT_LIMIT' | 'REMINDER_PROCESS_UNAVAILABLE' | 'REMINDER_RESULT_INVALID',
    readonly effects: 'none' | 'possible', readonly reconciliationRequired: boolean,
    readonly cleanupConfirmed = true) { super(code); }
}
/** Bounded I/O, one launch, no retries. Rejection never asserts that a launched write had no effect. */
export function createReminderTransaction({ launchProcess = launchProcessGroup, deadlineMs = 180_000, maxOutputBytes = 8_388_608 }:
  { launchProcess?: ProcessLauncher; deadlineMs?: number; maxOutputBytes?: number } = {}): ReminderTransaction {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 180_000 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 8_388_608) throw new Error('Reminder process budget invalid');
  return { async execute(request: ServiceRequest, authority: InvocationAuthority): Promise<unknown> {
    authority.signal.throwIfAborted(); assertInvocationCurrent(authority);
    const argv = buildArgv(request), mutation = !['list-reminders', 'find-reminders'].includes(request.operation);
    return new Promise((resolve, reject) => {
      let child: ProcessChild | undefined, closed = false, childClosed = false, launched = false, size = 0;
      let failure: ReminderProcessError['code'] | null = null;
      const chunks: Buffer[] = [];
      let hardKill: ReturnType<typeof setTimeout> | undefined;
      let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
      const clear = () => { clearTimeout(timer); clearTimeout(hardKill); clearTimeout(cleanupDeadline); authority.signal.removeEventListener('abort', abort); };
      const error = (reason: ReminderProcessError['code'], cleanupConfirmed = true) =>
        reject(new ReminderProcessError(reason, launched && mutation ? 'possible' : 'none', launched && mutation, cleanupConfirmed));
      const terminate = (signal: 'SIGTERM' | 'SIGKILL') => { try { child?.terminate(signal); } catch { /* Escalate, then report unconfirmed cleanup unless close is observed. */ } };
      function stop(code: ReminderProcessError['code']) {
        if (closed || failure) return;
        failure = code;
        hardKill = setTimeout(() => {
          cleanupDeadline = setTimeout(() => {
            if (closed) return;
            const cleanupConfirmed = childClosed && child?.hasProcesses() === false;
            closed = true; clear();
            try { child?.closeStreams(); } catch { /* Cleanup remains explicitly unconfirmed. */ }
            error(failure ?? code, cleanupConfirmed);
          }, 1_000);
          terminate('SIGKILL');
        }, 1_000);
        terminate('SIGTERM');
      }
      const abort = () => stop('REMINDER_ABORTED');
      const timer = setTimeout(() => stop('REMINDER_TIMEOUT'), deadlineMs);
      authority.signal.addEventListener('abort', abort, { once: true });
      const events: ProcessEvents = {
        stdout(chunk) { if (closed || failure) return; size += chunk.byteLength;
          if (size > maxOutputBytes) stop('REMINDER_OUTPUT_LIMIT'); else chunks.push(Buffer.from(chunk)); },
        stderr(_chunk) { /* Consume without retaining or disclosing backend diagnostics. */ },
        error() { stop('REMINDER_PROCESS_UNAVAILABLE'); },
        close(code) {
          if (closed) return;
          childClosed = true;
          // A wrapper closing its own pipes does not establish descendant cleanup.
          if (child?.hasProcesses() !== false) { if (!failure) stop('REMINDER_RESULT_INVALID'); return; }
          closed = true; clear();
          if (failure) { error(failure); return; }
          try {
            authority.signal.throwIfAborted(); assertInvocationCurrent(authority);
            const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8').trim());
            if (!plain(result) || code !== 0 && result.status !== 'failure') { error('REMINDER_RESULT_INVALID'); return; }
            resolve(result);
          } catch { error('REMINDER_RESULT_INVALID'); }
        },
      };
      try {
        authority.signal.throwIfAborted(); assertInvocationCurrent(authority);
        child = launchProcess(REMINDER_SERVICE_PATH, argv, events); launched = true;
        if (authority.signal.aborted) abort();
      } catch {
        closed = true; clear();
        reject(new ReminderProcessError('REMINDER_PROCESS_UNAVAILABLE', launched && mutation ? 'possible' : 'none', launched && mutation));
      }
    });
  } };
}
