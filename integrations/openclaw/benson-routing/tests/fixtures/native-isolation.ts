import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plain } from '../../core/value.js';

/** Closed, non-secret test input; never a runtime configuration or authority. */
export function validateStartupTargetMetadata(value: unknown) {
  const ids = ['benson-routing', 'benson-jessica-tool', 'benson-reminder-tool'];
  const projection = { codexEnabled: false, cronEnabled: false,
    mainTools: { allow: ['jessica_task', 'reminder_task'], codeMode: false },
    pluginPaths: ids.map(id => '/home/oa/projects/benson/output/typescript/integrations/openclaw/' +
      (id === 'benson-routing' ? id : 'plugins/' + id)),
    benson: ids.map(id => ({ id, enabled: true, allowConversationAccess: true })), whatsappEnabled: true };
  assert(plain(value)); assert.deepEqual(Object.keys(value).sort(), ['projection', 'whatsapp']);
  assert.deepEqual(value.projection, projection);
  assert(plain(value.whatsapp));
  const inputPins = value.whatsapp;
  const files = ['package.json', 'openclaw.plugin.json', 'dist/index.js', 'dist/.setup/monitor-B5qdng3U.mjs'];
  assert.deepEqual(Object.keys(value.whatsapp).sort(), [...files].sort());
  const whatsapp = Object.fromEntries(files.map(file => {
    const hash = inputPins[file]; assert(typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash));
    return [file, hash];
  }));
  return { projection, whatsapp };
}

/** Fail closed: both proof fixtures run only inside disposable Linux namespaces. */
export function runIsolatedFixture(target: 'native-correlation' | 'main-interception' | 'whatsapp-response-delivery' | 'tool-execution-receipts', codeModeOnly = false, completionV6Only: boolean | 'cancel' | 'multi' = false, mainHookSurfaceOnly = false, supportedNativeOnly = false, whatsappMonitorOnly: boolean | 'installed' | 'reminder-product' | 'startup-registry' = false): unknown {
  const startupRegistry = whatsappMonitorOnly === 'startup-registry';
  const targetMetadata = process.env.BENSON_NATIVE_STARTUP_TARGET_METADATA;
  if (targetMetadata) {
    assert(startupRegistry, 'Target metadata requires startup-only isolation');
    validateStartupTargetMetadata(JSON.parse(readFileSync(targetMetadata, 'utf8')));
  }
  const reminderProduct = whatsappMonitorOnly === 'reminder-product' || startupRegistry;
  const installed = whatsappMonitorOnly === 'installed' || reminderProduct;
  if (whatsappMonitorOnly && target !== 'whatsapp-response-delivery') throw new TypeError('Monitor proof requires its WhatsApp fixture');
  if (codeModeOnly && target !== 'main-interception') throw new TypeError('Code Mode requires the Main fixture');
  if (completionV6Only && (target !== 'native-correlation' || codeModeOnly)) throw new TypeError('Completion v6 requires its isolated correlation fixture');
  if (mainHookSurfaceOnly && (target !== 'main-interception' || codeModeOnly || completionV6Only)) throw new TypeError('Main hook surface requires its isolated Main fixture');
  if (supportedNativeOnly && (target !== 'main-interception' || codeModeOnly || completionV6Only || mainHookSurfaceOnly)) throw new TypeError('Supported native proof requires its isolated Main profile');
  const receiptPatch = target === 'tool-execution-receipts' || !!completionV6Only || target === 'whatsapp-response-delivery' && !reminderProduct;
  const repo = realpathSync(process.cwd());
  // Test the artifact that contains this fixture, including isolated candidate
  // builds. Never silently substitute the active production output directory.
  const emittedRoot = realpathSync(fileURLToPath(new URL('../../../../../', import.meta.url)));
  const npmCache = installed ? realpathSync(process.env.BENSON_WHATSAPP_NPM_CACHE ??
    join(repo, '.checkpoints/ts03-whatsapp-installer-20261031/npm-cache')) : undefined;
  let whatsappDirectory: string | undefined;
  if (target === 'whatsapp-response-delivery') {
    const owner = join(repo, 'integrations/openclaw/patches/whatsapp-response-controller');
    const manifest = JSON.parse(readFileSync(join(owner, 'manifest.json'), 'utf8')) as {
      version: string; hostVersion: string; integrity: string; target: string; beforeSha256: string; afterSha256: string;
    };
    assert.equal(manifest.version, '2026.10.10');
    const host = JSON.parse(readFileSync(join(repo, 'node_modules/openclaw/package.json'), 'utf8')) as { version: string };
    assert.equal(host.version, manifest.hostVersion);
    const archive = process.env.BENSON_WHATSAPP_ARCHIVE ?? join(repo, '.checkpoints/ts05-two-read-cutover-20261103/openclaw-2026.10.10-target/aligned-whatsapp-and-recovery/whatsapp-2026.10.10.tgz');
    assert.equal('sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64'), manifest.integrity);
    whatsappDirectory = mkdtempSync('/tmp/benson-whatsapp-proof-');
    try {
      execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', whatsappDirectory]);
      const root = join(whatsappDirectory, 'package');
      const plugin = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
      assert.equal(plugin.version, manifest.version);
      const hash = () => createHash('sha256').update(readFileSync(join(root, manifest.target))).digest('hex');
      assert.equal(hash(), manifest.beforeSha256);
      execFileSync('/usr/bin/patch', ['--batch', '--fuzz=0', '--forward', '-p1', '-d', root,
        '--input', join(owner, '2026.10.10.patch')], { stdio: 'pipe' });
      assert.equal(hash(), manifest.afterSha256);
    } catch (error) { rmSync(whatsappDirectory, { recursive: true }); throw error; }
  }
  try {
  const output = execFileSync('/usr/bin/bwrap', [
    '--unshare-all', '--die-with-parent', '--new-session',
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/repo',
    ...targetMetadata ? ['--ro-bind', realpathSync(targetMetadata), '/target-registration-metadata.json'] : [],
    '--ro-bind', `${repo}/node_modules`, '/repo/node_modules',
    // Stock package lifecycle may write only to an invisible, disposable SDK overlay.
    '--overlay-src', `${repo}/node_modules/openclaw`, '--tmp-overlay', '/repo/node_modules/openclaw',
    ...receiptPatch ? ['--ro-bind', `${repo}/integrations/openclaw/patches/tool-execution-receipts`, '/receipt-patch'] : [],
    '--ro-bind', emittedRoot, '/repo/output/typescript',
    ...reminderProduct ? [
      // Only synthetic resources are writable, inside this disposable namespace.
      '--tmpfs', '/repo/output/typescript/agents/reminder-service/config',
      '--tmpfs', '/repo/output/typescript/agents/reminder-service/tools',
      '--tmpfs', '/repo/output/typescript/agents/jessica-vacuum/config',
      '--ro-bind', `${repo}/integrations/openclaw/plugins/benson-jessica-tool/openclaw.plugin.json`, '/jessica-plugin-manifest.json',
      '--ro-bind', `${repo}/integrations/openclaw/plugins/benson-reminder-tool/openclaw.plugin.json`, '/reminder-plugin-manifest.json',
      '--ro-bind', `${repo}/integrations/openclaw/benson-routing/openclaw.plugin.json`, '/routing-plugin-manifest.json',
    ] : [],
    '--ro-bind', `${repo}/agents/jessica-vacuum/config/registry.v1.json`, '/repo/agents/jessica-vacuum/config/registry.v1.json',
    ...installed ? [
      ...['config/policy.v1.json', 'tests/fixtures/map-stage2-live.json'].flatMap(file => [
        '--ro-bind', join(repo, 'agents/jessica-vacuum', file), `/repo/agents/jessica-vacuum/${file}`,
      ]),
      '--symlink', 'usr/bin', '/bin',
      '--dir', '/npm-cache-seed', '--ro-bind', join(npmCache!, '_cacache'), '/npm-cache-seed/_cacache',
      '--ro-bind', join(repo, 'integrations/openclaw/patches/whatsapp-response-controller'), '/whatsapp-response-controller',
      '--dir', '/routing',
      ...['classification.mjs', 'policy.mjs', 'rubric.json'].flatMap(file => [
        '--ro-bind', join(repo, 'integrations/openclaw/benson-routing', file), `/routing/${file}`,
      ]),
    ] : [],
    ...target === 'whatsapp-response-delivery' ? [
      '--ro-bind', join(whatsappDirectory!, 'package'), '/whatsapp',
      '--symlink', '/repo/node_modules', '/node_modules',
    ] : [],
    '--clearenv', '--setenv', 'PATH', '/usr/bin', '--setenv', 'HOME', '/tmp/home',
    '--setenv', 'OPENCLAW_HOME', '/tmp/home', '--setenv', 'OPENCLAW_STATE_DIR', '/tmp/state',
    '--setenv', 'OPENCLAW_CONFIG_PATH', '/tmp/config.json',
    '--setenv', 'BENSON_NATIVE_CORRELATION_ISOLATED', '1', '--chdir', '/repo',
    ...codeModeOnly ? ['--setenv', 'BENSON_NATIVE_CODE_MODE_ONLY', '1'] : [],
    ...completionV6Only ? ['--setenv', 'BENSON_NATIVE_COMPLETION_V6_ONLY', typeof completionV6Only === 'string' ? completionV6Only : '1'] : [],
    ...mainHookSurfaceOnly ? ['--setenv', 'BENSON_NATIVE_MAIN_HOOK_SURFACE_ONLY', '1'] : [],
    ...supportedNativeOnly ? ['--setenv', 'BENSON_NATIVE_SUPPORTED_RESPONSE_ONLY', '1'] : [],
    ...whatsappMonitorOnly ? ['--setenv', 'BENSON_NATIVE_WHATSAPP_MONITOR_ONLY', '1'] : [],
    ...installed ? ['--setenv', 'BENSON_NATIVE_WHATSAPP_INSTALLER_ONLY', '1'] : [],
    ...reminderProduct ? ['--setenv', 'BENSON_NATIVE_REMINDER_PRODUCT_ONLY', '1'] : [],
    ...startupRegistry ? ['--setenv', 'BENSON_NATIVE_STARTUP_REGISTRY_ONLY', '1', '--setenv', 'OPENCLAW_SKIP_CHANNELS', '1', '--setenv', 'OPENCLAW_SKIP_CRON', '1'] : [],
    ...receiptPatch ? ['/usr/bin/bash', '--noprofile', '--norc', '-c',
      `node /receipt-patch/manage.mjs apply /repo/node_modules/openclaw >/tmp/receipt-patch-apply.json && node /receipt-patch/manage.mjs verify /repo/node_modules/openclaw >>/tmp/receipt-patch-apply.json && exec node /repo/output/typescript/integrations/openclaw/benson-routing/tests/fixtures/${target}.js --worker`] :
      ['/usr/bin/node', `/repo/output/typescript/integrations/openclaw/benson-routing/tests/fixtures/${target}.js`, '--worker'],
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    // Installed profile adds bounded install (60s), inspection and config (30s each) before
    // the unchanged gateway proof budget. Leave time for its failure diagnostics.
    timeout: startupRegistry ? 450_000 : installed ? 290_000 : 170_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(output.trim());
  } finally { if (whatsappDirectory) rmSync(whatsappDirectory, { recursive: true }); }
}
