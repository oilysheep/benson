import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const owner = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(owner, 'manifest.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function manageReceiptPatch(action, root) {
  assert(['preflight', 'apply', 'verify', 'rollback'].includes(action), 'Unknown patch action');
  const target = realpathSync(root);
  const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'openclaw'); assert.equal(pkg.version, '2026.10.4');
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.contract, 'openclaw.tool-execution-evidence.v1');
  const patch = join(owner, '2026.10.4.patch');
  assert.equal(hash(readFileSync(patch)), manifest.patchSha256, 'Patch drift');
  const after = action === 'verify' || action === 'rollback';
  const check = patched => {
    for (const file of manifest.files) {
      assert(file.path.startsWith('dist/') && !file.path.split('/').includes('..'), 'Invalid patch target');
      const expected = patched ? file.afterSha256 : file.beforeSha256;
      const path = join(target, file.path);
      if (expected === null) assert(!existsSync(path), 'Unexpected added target');
      else assert.equal(hash(readFileSync(path)), expected, `Unsupported bytes: ${file.path}`);
    }
  };
  check(after);
  if (action === 'apply' || action === 'rollback') {
    assert.equal(target, '/repo/node_modules/openclaw', 'Mutation requires the approved disposable SDK overlay');
    assert.equal(existsSync('/home/oa'), false, 'Host home must be hidden');
    assert(readFileSync('/proc/self/mountinfo', 'utf8').split('\n').some(line =>
      line.includes(' /repo/node_modules/openclaw ') && line.includes(' - overlay ')), 'Not an isolated overlay');
    const args = ['--batch', '--fuzz=0', '--no-backup-if-mismatch', after ? '--reverse' : '--forward', '-p1', '-d', target, '--input', patch];
    execFileSync('/usr/bin/patch', ['--dry-run', ...args], { stdio: 'pipe' });
    execFileSync('/usr/bin/patch', args, { stdio: 'pipe' });
    check(!after);
  }
  return { action, version: pkg.version, files: manifest.files.length, status: 'PASS' };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 4, 'Use manage.mjs preflight|apply|verify|rollback <package-root>');
  console.log(JSON.stringify(manageReceiptPatch(process.argv[2], process.argv[3])));
}
