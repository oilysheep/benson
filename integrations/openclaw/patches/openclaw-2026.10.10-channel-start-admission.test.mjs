import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';

// Execute the complete version-pinned manager module with inert dependencies.
// No installed module is imported; no filesystem, process, network or auth API
// is exposed to the evaluated code. This is source/fixture evidence only.
const sourcePath = process.env.BENSON_CHANNEL_START_CANDIDATE;
assert(sourcePath, 'Supply the isolated candidate file explicitly');
const source = fs.readFileSync(sourcePath, 'utf8');
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function flush() { await nextTurn(); }
function fixture({ barrier = deferred(), accountGate } = {}) {
  const drain = new AbortController(), root = new AbortController();
  let closing = false, entries = 0, stoppedSchedulers = 0;
  const finish = deferred(), messages = [];
  const log = { info: x => messages.push(x), warn: () => {}, error: () => {} };
  const account = { enabled: true, configured: true, linked: true };
  const plugin = {
    id: 'whatsapp', meta: { label: 'Synthetic WhatsApp' },
    config: { listAccountIds: () => ['benson'], resolveAccount: () => account,
      isEnabled: () => true, isConfigured: () => true, isLinked: () => true },
    gateway: { startAccount: async ctx => {
      entries++;
      ctx.setStatus({ lifecycle: 'ready', running: true, connected: true });
      await finish.promise;
      ctx.setStatus({ lifecycle: 'blocked', running: false, connected: false, terminalDisconnect: true });
    } }
  };
  const registry = { plugins: [], channels: [{ plugin, pluginId: 'whatsapp' }] };
  const wrap = run => run();
  const context = {
    AbortController, AbortSignal, setImmediate, clearTimeout,
    createDeferredCore: deferred,
    formatErrorMessage: e => String(e.message ?? e),
    createSubsystemLogger: () => log, runtimeForLogger: () => ({}),
    getLoadedChannelPluginEntryById: id => id === plugin.id ? registry.channels[0] : undefined,
    listLoadedChannelPluginsForRegistry: () => [plugin],
    withPluginRuntimeRegistryScope: (_r, run) => run(),
    withPluginRuntimeGatewayContextResolver: (_r, run) => run(),
    withoutGatewayToolCallerIdentity: wrap, runOutsideOperatorToolGatewayAuthority: wrap,
    runOutsidePluginLifecycleLease: wrap, runOutsideGatewayRootWorkAdmission: wrap,
    runOutsidePluginRuntimeGenerationScope: wrap, runOutsideAsyncWorkScope: wrap,
    withPluginHttpRouteRegistry: (_r, run) => run(),
    withPluginServiceScheduler: (_s, run) => run(),
    withGatewayNativeApprovalRuntime: (_r, run) => run(),
    createPluginRuntimeCapabilityLease: () => {
      let active = true;
      return { assertActive: () => assert(active), isActive: () => active, revoke: () => { active = false; } };
    },
    getPluginValueInstance: () => undefined,
    createPluginServiceSchedulerRunner: () => ({}),
    createPluginServiceScheduler: () => ({ scheduler: {
      signal: root.signal, beginClose: () => {}, stop: async () => { stoppedSchedulers++; }
    } }),
    clearActiveCredentialDegradedOwner: () => {}, assertSecretOwnerAvailable: () => {},
    resetDirectoryCache: () => {},
    resolveChannelAccount: async () => { if (accountGate) await accountGate.promise; return account; },
    describeChannelAccount: () => ({ linked: true }),
    isAccountEnabled: () => true, isChannelAccountExplicitlyDisabled: () => false,
    getCredentialUnavailableDiagnostics: () => [],
    createTaskScopedChannelRuntime: () => ({ channelRuntime: {}, dispose: () => {} }),
    resolveChannelApprovalCapability: () => undefined,
    normalizeAccountId: x => x, normalizeOptionalAccountId: x => x,
    resolveChannelDefaultAccountId: () => 'benson',
    resolveUnavailableChannelAccountSnapshot: () => undefined,
    buildChannelAccountSnapshotFromRuntime: ({ runtime }) => runtime,
    buildChannelAccountSnapshotFromInspection: ({ runtime }) => runtime,
    isChannelStartupSuppressedByEnvironment: () => false,
    isGatewayRestartDraining: () => drain.signal.aborted,
    getGatewayRestartDrainSignal: () => drain.signal,
    GatewayDrainingError: class GatewayDrainingError extends Error {
      constructor() { super('Gateway is draining'); this.name = 'GatewayDrainingError'; }
    },
    runTasksWithConcurrency: async ({ tasks }) => {
      const results = await Promise.allSettled(tasks.map(run => run()));
      const failure = results.find(r => r.status === 'rejected');
      return { hasError: !!failure, firstError: failure?.reason };
    }
  };
  const body = source.replace(/^import .*;\n/gm, '').replace(/^export \{.*\};\s*$/m, '');
  const create = vm.runInNewContext(body + '\ncreateChannelManager;', context, { timeout: 1000 });
  const manager = create({
    scheduler: { signal: root.signal }, getRuntimeConfig: () => ({ channels: { whatsapp: {} } }),
    getPluginRegistry: () => registry, channelLogs: { whatsapp: log }, channelRuntimeEnvs: { whatsapp: {} },
    channelRuntime: {}, deferStartupAccountStartsUntil: barrier.promise, isClosing: () => closing
  });
  return { manager, barrier, drain, finish, messages, setClosing: () => { closing = true; },
    entries: () => entries, stoppedSchedulers: () => stoppedSchedulers,
    status: () => manager.getRuntimeSnapshot({ inspectAccounts: false }).channelAccounts.whatsapp.benson };
}

test('health-monitor and startup share one pending barrier and one provider lifetime', async () => {
  const f = fixture();
  await f.manager.startChannel('whatsapp', 'benson', { reason: 'health-monitor' });
  await f.manager.startChannels();
  await flush();
  assert.equal(f.entries(), 0, 'No monitor/provider entry before startup barrier');
  f.barrier.resolve(); await flush();
  assert.equal(f.entries(), 1);
  assert.equal(f.messages.filter(x => x.includes('starting account')).length, 1);
  f.finish.resolve(); await flush();
  assert.equal(f.status().terminalDisconnect, true);
  assert.equal(f.manager.isAutoRestartScheduled('whatsapp', 'benson'), false);
});

test('committed stop refuses late startup without clearing terminal status', async () => {
  const f = fixture(); f.barrier.resolve();
  await f.manager.startChannel('whatsapp', 'benson', { reason: 'startup' }); await flush();
  f.finish.resolve(); await flush();
  assert.equal(f.status().terminalDisconnect, true);
  f.drain.abort();
  await assert.rejects(f.manager.startChannel('whatsapp', 'benson', { reason: 'startup' }), { name: 'GatewayDrainingError' });
  assert.equal(f.entries(), 1);
  assert.equal(f.status().terminalDisconnect, true);
});

test('drain releases an unresolved common barrier without a provider or wait deadlock', async () => {
  const f = fixture();
  await f.manager.startChannel('whatsapp', 'benson', { reason: 'health-monitor' }); await flush();
  f.drain.abort(); await flush();
  assert.equal(f.entries(), 0);
  assert.equal(f.manager.hasCurrentAccountTask('whatsapp', 'benson'), false);
  assert.equal(f.stoppedSchedulers(), 1);
  assert.equal(f.manager.isAutoRestartScheduled('whatsapp', 'benson'), false);
});

test('drain during awaited account preparation prevents lifecycle/monitor handoff', async () => {
  const accountGate = deferred(), f = fixture({ accountGate }); f.barrier.resolve();
  const starting = f.manager.startChannel('whatsapp', 'benson', { reason: 'health-monitor' });
  await flush(); f.drain.abort(); accountGate.resolve();
  await assert.rejects(starting, { name: 'GatewayDrainingError' });
  assert.equal(f.entries(), 0);
  assert.equal(f.manager.hasCurrentAccountTask('whatsapp', 'benson'), false);
});

test('close prelude independently refuses a new account start', async () => {
  const f = fixture(); f.setClosing(); f.barrier.resolve();
  await assert.rejects(f.manager.startChannel('whatsapp', 'benson', { reason: 'startup' }), { name: 'GatewayDrainingError' });
  assert.equal(f.entries(), 0);
});

test('version-pinned artifact applies exactly, detects drift, rejects repeats and restores preimage', () => {
  const owner = import.meta.dirname;
  const manifest = JSON.parse(fs.readFileSync(path.join(owner, 'openclaw-2026.10.10-channel-start-admission.manifest.json')));
  const sdk = '/home/oa/.npm-global/lib/node_modules/openclaw';
  const hash = b => createHash('sha256').update(b).digest('hex');
  assert.equal(JSON.parse(fs.readFileSync(sdk + '/package.json')).version, manifest.version);
  for (const [file, expected] of Object.entries(manifest.hostFiles)) {
    assert.equal(hash(fs.readFileSync(sdk + '/' + file)), expected, 'Host dependency drift: ' + file);
  }
  const artifact = path.join(owner, manifest.artifact), [file] = manifest.files;
  assert.equal(hash(fs.readFileSync(artifact)), manifest.artifactSha256);
  const before = fs.readFileSync(sdk + '/' + file.path);
  assert.equal(hash(before), file.beforeSha256, 'Installed Core must remain the accepted preimage');
  assert.equal(hash(Buffer.from(source)), file.afterSha256, 'Exercise exact candidate bytes');
  // Disposable files only; never apply to the installed SDK.
  const directory = fs.mkdtempSync('/tmp/benson-channel-start-artifact-');
  const target = path.join(directory, file.path);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, before, { mode: Number.parseInt(file.mode, 8) });
    const args = ['--batch', '--fuzz=0', '--forward', '--no-backup-if-mismatch', '-p1', '-d', directory, '--input', artifact];
    const output = execFileSync('/usr/bin/patch', args, { encoding: 'utf8' });
    assert(!/offset|fuzz/i.test(output));
    assert.equal(hash(fs.readFileSync(target)), file.afterSha256);
    assert.equal(fs.statSync(target).mode & 0o777, Number.parseInt(file.mode, 8));
    assert.notEqual(spawnSync('/usr/bin/patch', ['--dry-run', ...args]).status, 0);
    const reverseArgs = ['--force', ...args.map(x => x === '--forward' ? '--reverse' : x)];
    execFileSync('/usr/bin/patch', reverseArgs);
    assert(fs.readFileSync(target).equals(before));
    // Every changed hunk is already reversed: a reverse dry run must reject.
    assert.notEqual(spawnSync('/usr/bin/patch', ['--dry-run', ...reverseArgs]).status, 0);
    // Hash admission must detect foreign bytes even if patch would match.
    fs.appendFileSync(target, '\n// foreign bytes\n');
    assert.notEqual(hash(fs.readFileSync(target)), file.beforeSha256);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
