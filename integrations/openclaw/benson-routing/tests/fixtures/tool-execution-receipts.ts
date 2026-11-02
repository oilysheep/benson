import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { observeOpenClawToolExecution } from '../../adapters/openclaw/tool-execution-evidence.js';
import { readToolExecutionEvidence } from '../../core/tool-execution-evidence.js';
import { isolated, worker, writeReport } from './native-correlation.js';

export default { id: 'benson-jessica-tool', register(api: OpenClawPluginApi) {
  isolated();
  const states = new Map<string, { count: number; starts: number; releases: (() => void)[]; order: number[]; started: () => void }>();
  api.on('before_tool_call', event => {
    if (event.toolName === 'jessica_read' && event.params.mode === 'blocked') return { block: true, blockReason: 'Isolated denied execution' };
    if (event.toolName === 'jessica_read' && event.params.mode === 'adjusted') return { params: { ...event.params, index: 10 } };
    return undefined;
  });
  api.registerTool({ contextVersion: 2, create(context) { return {
    name: 'jessica_read', label: 'Receipt fixture', description: 'Read synthetic isolated data.',
    parameters: { type: 'object', properties: { index: { type: 'integer', minimum: 0 }, mode: { type: 'string' } }, required: ['index', 'mode'], additionalProperties: false },
    async execute(_id, args, signal) {
      context.assertInvocationCurrent();
      const state = states.get(context.sessionKey!); assert(state);
      assert(args && typeof args === 'object');
      const index = Reflect.get(args, 'index') as number, mode = Reflect.get(args, 'mode');
      state.starts++; state.started();
      if (mode === 'failed') throw new Error('Isolated implementation failure');
      if (mode === 'interrupt') await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
      if (state.count > 1) {
        const waiting = Promise.withResolvers<void>(); state.releases[index] = waiting.resolve;
        if (state.starts === state.count) state.releases[state.count - 1]!();
        await waiting.promise;
      }
      state.order.push(index); if (index > 0) state.releases[index - 1]?.();
      return { content: [{ type: 'text' as const, text: JSON.stringify({ index, value: 'fixture' }) }], details: { index, value: 'fixture' } };
    },
  }; } }, { optional: true });
  api.on('gateway_start', async () => {
    const cases: string[] = [];
    try {
      const run = async (mode: string, count: number) => {
        const sessionKey = `agent:jessica-vacuum:subagent:receipt-${randomUUID()}`;
        const started = Promise.withResolvers<void>();
        const state = { count: mode === 'duplicate' ? 1 : count, starts: 0, releases: [] as (() => void)[], order: [] as number[], started: started.resolve };
        states.set(sessionKey, state);
        let dropReceipt = false, disposeFault: (() => void) | undefined;
        if (mode === 'missing') {
          const entry = 'openclaw/plugin-sdk/agent-core', native: unknown = await import(entry);
          assert(native && typeof native === 'object');
          const watch: unknown = Reflect.get(native, 'observeToolExecutionEvidence'); assert.equal(typeof watch, 'function');
          // Cause the real adapter to miss one exact native receipt; native
          // execution must remain unchanged while coverage fails closed.
          disposeFault = (watch as (key: string, receive: (event: unknown) => void) => () => void)(sessionKey, event => {
            if (event && typeof event === 'object' && Reflect.get(event, 'type') === 'receipt') {
              const receipt: unknown = Reflect.get(event, 'receipt');
              if (receipt && typeof receipt === 'object' && Reflect.get(receipt, 'ordinal') === 1) dropReceipt = true;
            }
          });
        }
        let sourceCurrent = true;
        const provider = await observeOpenClawToolExecution(sessionKey, () => {
          assert(sourceCurrent, 'original source retired');
          if (dropReceipt) { dropReceipt = false; throw new Error('Isolated receipt capture loss'); }
        }, new URL('file:///receipt-patch/manifest.json'));
        const launch = await api.runtime.subagent.run({ sessionKey, message: `${mode} ${count === 5 ? 'five' : count === 3 ? 'three' : ''}`,
          toolsAlsoAllow: ['jessica_read'], deliver: false, promptMode: 'minimal' });
        const identity = () => {
          // Native begin supplies sessionId; no identity is minted from model text.
          const handle = provider.evidence(launch.runId);
          return { handle, coverage: provider.inspectIdentity(launch.runId) };
        };
        if (mode === 'interrupt') {
          await started.promise;
          assert.throws(() => provider.evidence(launch.runId) && readToolExecutionEvidence(identity().handle, identity().coverage), /unsealed/);
          assert.throws(() => provider.close(), /unsealed/);
          cases.push('interrupted Run cannot settle before native seal');
          provider.dispose(); return;
        }
        const terminal = await api.runtime.subagent.waitForRun({ runId: launch.runId, timeoutMs: 45_000 });
        if (mode !== 'duplicate') assert.equal(terminal.status, 'ok');
        else assert(['ok', 'error'].includes(terminal.status));
        await provider.waitForSettlement(launch.runId, AbortSignal.timeout(10_000));
        const { handle, coverage: binding } = identity();
        if (mode === 'duplicate') { assert.throws(() => readToolExecutionEvidence(handle, binding), /coverage_unverified/); cases.push('duplicate native identity refuses complete coverage'); provider.dispose(); return; }
        if (mode === 'missing') {
          assert.equal(state.starts, count); assert.equal(state.order.length, count);
          assert.throws(() => readToolExecutionEvidence(handle, binding), /coverage_unverified/);
          cases.push('missing native receipt refuses complete coverage without changing execution');
          provider.dispose(); disposeFault?.(); return;
        }
        const coverage = readToolExecutionEvidence(handle, binding);
        assert.equal(binding.runId, launch.runId); assert.equal(binding.sessionKey, sessionKey);
        assert.equal(coverage.receipts.length, count);
        for (const [ordinal, receipt] of coverage.receipts.entries()) {
          assert.equal(receipt.ordinal, ordinal); assert.equal(receipt.callId, `receipt-call-${ordinal}`);
          assert.equal(receipt.name, mode === 'synthetic' ? 'absent_tool' : 'jessica_read');
          assert.equal(receipt.executionStarted, !['blocked', 'synthetic'].includes(mode));
          // Plugin exceptions are converted to a public carrier before Agent Core;
          // native after-outcome processing supplies the final error flag.
          assert.equal(receipt.originalIsError, mode === 'synthetic', JSON.stringify({ mode, receipt }));
          assert.equal(receipt.isError, ['failed', 'blocked', 'synthetic'].includes(mode), JSON.stringify({ mode, receipt }));
          if (mode === 'failed') assert(JSON.stringify(receipt.originalResult).includes('Isolated implementation failure'));
          if (mode === 'adjusted') assert.deepEqual(JSON.parse(JSON.stringify(receipt.executionArgs)), { index: 10, mode });
          assert.deepEqual(JSON.parse(JSON.stringify(receipt.originalArgs)), { index: ordinal, mode });
        }
        if (count > 1) assert.deepEqual(state.order, Array.from({ length: count }, (_, i) => count - 1 - i));
        cases.push(`${mode}: ${count} exact receipts`);
        const pendingWait = assert.rejects(provider.waitForSettlement('never-started-run', AbortSignal.timeout(1_000)), /subscription_closed/);
        provider.close(); provider.close();
        await pendingWait;
        assert.deepEqual(readToolExecutionEvidence(handle, binding), coverage);
        await assert.rejects(provider.waitForSettlement('unobserved-run', AbortSignal.timeout(1_000)), /subscription_closed/);
        sourceCurrent = false;
        assert.throws(() => readToolExecutionEvidence(handle, binding), /original source retired/);
        sourceCurrent = true;
        provider.dispose(); assert.throws(() => readToolExecutionEvidence(handle, binding));
      };
      await Promise.all([run('normal', 3), run('normal', 5)]);
      await run('zero', 0); await run('blocked', 1); await run('failed', 1); await run('synthetic', 1); await run('adjusted', 1); await run('duplicate', 3);
      await run('missing', 3); await run('interrupt', 1);
      writeReport({ mapping: 'PASS', cases, effects: 0, limits: 'Isolated real native lifecycle; synthetic tool results, no domain authority or business effects.' });
    } catch (error) { writeReport({ mapping: 'BLOCKED', cases, error: error instanceof Error ? error.stack : String(error) }); }
  }, { timeoutMs: 100_000 });
} };
async function isolatedWorker() {
  isolated();
  const root = '/repo/node_modules/openclaw', manifest = '/receipt-patch/manifest.json';
  const manage = (action: string) => execFileSync('/usr/bin/node', ['/receipt-patch/manage.mjs', action, root], { stdio: 'pipe' });
  manage('verify'); assert.throws(() => manage('apply')); assert.throws(() => manage('preflight'));
  const pin = JSON.parse(readFileSync(manifest, 'utf8')) as { files: { path: string }[] };
  const target = root + '/' + pin.files[0]!.path, bytes = readFileSync(target);
  try { writeFileSync(target, Buffer.concat([bytes, Buffer.from('\n')])); assert.throws(() => manage('verify')); assert.throws(() => manage('rollback'));
    await assert.rejects(observeOpenClawToolExecution('session', () => {}, new URL('file://' + manifest)), /source_drift/);
  } finally { writeFileSync(target, bytes); }
  const pkgPath = root + '/package.json', pkg = readFileSync(pkgPath);
  try { const value = JSON.parse(pkg.toString()); value.version = '2026.10.5'; writeFileSync(pkgPath, JSON.stringify(value));
    assert.throws(() => manage('verify')); await assert.rejects(observeOpenClawToolExecution('session', () => {}, new URL('file://' + manifest)), /version_mismatch/);
  } finally { writeFileSync(pkgPath, pkg); }
  manage('rollback'); manage('preflight'); const original = readFileSync(target); assert.throws(() => manage('verify')); manage('apply');
  try { writeFileSync(target, original); for (const action of ['apply', 'rollback', 'verify', 'preflight']) assert.throws(() => manage(action)); } finally { writeFileSync(target, bytes); }
  manage('verify');
  await worker('tool-execution-receipts');
}
if (process.argv[1] === new URL(import.meta.url).pathname && process.argv.includes('--worker')) void isolatedWorker();
