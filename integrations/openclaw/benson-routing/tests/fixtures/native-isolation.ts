import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Fail closed: both proof fixtures run only inside disposable Linux namespaces. */
export function runIsolatedFixture(target: 'native-correlation' | 'main-interception' | 'whatsapp-response-delivery', codeModeOnly = false, completionV6Only: boolean | 'cancel' = false, mainHookSurfaceOnly = false, supportedNativeOnly = false, whatsappMonitorOnly: boolean | 'installed' = false): unknown {
  if (whatsappMonitorOnly && target !== 'whatsapp-response-delivery') throw new TypeError('Monitor proof requires its WhatsApp fixture');
  if (codeModeOnly && target !== 'main-interception') throw new TypeError('Code Mode requires the Main fixture');
  if (completionV6Only && (target !== 'native-correlation' || codeModeOnly)) throw new TypeError('Completion v6 requires its isolated correlation fixture');
  if (mainHookSurfaceOnly && (target !== 'main-interception' || codeModeOnly || completionV6Only)) throw new TypeError('Main hook surface requires its isolated Main fixture');
  if (supportedNativeOnly && (target !== 'main-interception' || codeModeOnly || completionV6Only || mainHookSurfaceOnly)) throw new TypeError('Supported native proof requires its isolated Main profile');
  const repo = realpathSync(process.cwd());
  const npmCache = whatsappMonitorOnly === 'installed' ? realpathSync(process.env.BENSON_WHATSAPP_NPM_CACHE ??
    join(repo, '.checkpoints/ts03-whatsapp-installer-20261031/npm-cache')) : undefined;
  let whatsappDirectory: string | undefined;
  if (target === 'whatsapp-response-delivery') {
    const owner = join(repo, 'integrations/openclaw/patches/whatsapp-response-controller');
    const manifest = JSON.parse(readFileSync(join(owner, 'manifest.json'), 'utf8')) as {
      version: string; hostVersion: string; integrity: string; target: string; beforeSha256: string; afterSha256: string;
    };
    assert.equal(manifest.version, '2026.10.4');
    const host = JSON.parse(readFileSync(join(repo, 'node_modules/openclaw/package.json'), 'utf8')) as { version: string };
    assert.equal(host.version, manifest.hostVersion);
    const archive = process.env.BENSON_WHATSAPP_ARCHIVE ?? join(repo, '.checkpoints/ts03-whatsapp-plugin-20261030/whatsapp-2026.10.4.tgz');
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
        '--input', join(owner, '2026.10.4.patch')], { stdio: 'pipe' });
      assert.equal(hash(), manifest.afterSha256);
    } catch (error) { rmSync(whatsappDirectory, { recursive: true }); throw error; }
  }
  try {
  const output = execFileSync('/usr/bin/bwrap', [
    '--unshare-all', '--die-with-parent', '--new-session',
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/repo',
    '--ro-bind', `${repo}/node_modules`, '/repo/node_modules',
    // Stock package lifecycle may write only to an invisible, disposable SDK overlay.
    '--overlay-src', `${repo}/node_modules/openclaw`, '--tmp-overlay', '/repo/node_modules/openclaw',
    '--ro-bind', `${repo}/output/typescript`, '/repo/output/typescript',
    ...whatsappMonitorOnly === 'installed' ? [
      '--symlink', 'usr/bin', '/bin',
      '--dir', '/npm-cache-seed', '--ro-bind', join(npmCache!, '_cacache'), '/npm-cache-seed/_cacache',
      '--ro-bind', join(repo, 'integrations/openclaw/patches/whatsapp-response-controller'), '/whatsapp-response-controller',
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
    ...completionV6Only ? ['--setenv', 'BENSON_NATIVE_COMPLETION_V6_ONLY', completionV6Only === 'cancel' ? 'cancel' : '1'] : [],
    ...mainHookSurfaceOnly ? ['--setenv', 'BENSON_NATIVE_MAIN_HOOK_SURFACE_ONLY', '1'] : [],
    ...supportedNativeOnly ? ['--setenv', 'BENSON_NATIVE_SUPPORTED_RESPONSE_ONLY', '1'] : [],
    ...whatsappMonitorOnly ? ['--setenv', 'BENSON_NATIVE_WHATSAPP_MONITOR_ONLY', '1'] : [],
    ...whatsappMonitorOnly === 'installed' ? ['--setenv', 'BENSON_NATIVE_WHATSAPP_INSTALLER_ONLY', '1'] : [],
    '/usr/bin/node', `/repo/output/typescript/integrations/openclaw/benson-routing/tests/fixtures/${target}.js`, '--worker',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    // Installed profile adds bounded install (60s), inspection and config (30s each) before
    // the unchanged gateway proof budget. Leave time for its failure diagnostics.
    timeout: whatsappMonitorOnly === 'installed' ? 290_000 : 170_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(output.trim());
  } finally { if (whatsappDirectory) rmSync(whatsappDirectory, { recursive: true }); }
}
