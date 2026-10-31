import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Development-only declaration correction approved in Implementation Plan §11.
// Never write into node_modules or publish this type-only artifact as a runtime.
const root = fileURLToPath(new URL('../', import.meta.url));
const sdk = join(root, 'node_modules/openclaw');
const overlay = join(root, 'output/ts-sdk-overlay');
const read = path => readFileSync(path, 'utf8');
const digest = text => createHash('sha256').update(text).digest('hex');
const json = path => JSON.parse(read(path));
assert.ok(process.argv.slice(2).every(arg => arg === '--noEmit'), 'Only --noEmit is supported');
const pkg = json(join(sdk, 'package.json'));
assert.equal(pkg.name, 'openclaw');
assert.equal(pkg.version, '2026.10.4');
assert.equal(pkg.type, 'module');
assert.deepEqual(pkg.exports['./plugin-sdk/plugin-entry'], {
  types: './dist/plugin-sdk/plugin-entry.d.ts', default: './dist/plugin-sdk/plugin-entry.js',
});
assert.deepEqual(pkg.exports['./plugin-sdk/reply-runtime'], {
  types: './dist/plugin-sdk/reply-runtime.d.ts', default: './dist/plugin-sdk/reply-runtime.js',
});
assert.equal(json(join(root, 'package.json')).type, 'module');
assert.equal(json(join(root, 'node_modules/typescript/package.json')).version, '7.0.2');
assert.equal(json(join(root, 'node_modules/@types/ws/package.json')).version, '8.18.1');
const options = json(join(root, 'tsconfig.json')).compilerOptions;
for (const flag of ['strict', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes', 'noImplicitReturns',
  'noFallthroughCasesInSwitch', 'useUnknownInCatchVariables', 'verbatimModuleSyntax', 'noEmitOnError']) {
  assert.equal(options[flag], true, `Required compiler flag: ${flag}`);
}
for (const flag of ['skipLibCheck', 'skipDefaultLibCheck', 'noCheck']) assert.notEqual(options[flag], true, `Forbidden compiler flag: ${flag}`);

const sources = [
  ['agent-harness-runtime-DZjstJNb.d.ts', '579e0bb10c356e3cad710411b0f36b37fe70348dc7e15448361202f3b9e991a7'],
  ['plugin-sdk/plugin-entry.d.ts', '0a4c99523de9000d90e4be08227261b3e5958f1ead5372364942909e78dc96d7'],
  ['plugin-entry-D4JWmN6h.d.ts', '48119827bb1152bbde76722ce8d6b72362e34de469b753e31a883108270f22f9'],
  ['plugin-sdk/reply-runtime.d.ts', '6eec7f3c85d878afed72e900033c37ff435059cda688e98512a347b739f1b008'],
];
const declarations = sources.map(([path, expected]) => {
  const text = read(join(sdk, 'dist', path));
  assert.equal(digest(text), expected, `Unsupported SDK declaration bytes: ${path}`);
  return { path, text };
});
const needle = '  type: "label";\n  targetId: string;\n  label?: string;\n} | {';
const monolith = declarations[0];
assert.equal(monolith.text.split(needle).length, 2, 'The correction must have exactly one target');
monolith.text = monolith.text.replace(needle, needle.replace('label?: string;', 'label?: string | undefined;'));
assert.equal(digest(monolith.text), '08a1539a3259e7f7006a28699ffa38935b5453e43defb0ffa2e597880882beae');
function generate(path, text) {
  if (existsSync(path) && read(path) === text) return;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}
for (const { path, text } of declarations) generate(join(overlay, 'dist', path), text);
generate(join(overlay, 'tsconfig.json'), JSON.stringify({
  extends: '../../tsconfig.json',
  compilerOptions: {
    paths: {
      'openclaw/plugin-sdk/plugin-entry': ['./dist/plugin-sdk/plugin-entry.d.ts'],
      'openclaw/plugin-sdk/reply-runtime': ['./dist/plugin-sdk/reply-runtime.d.ts'],
    },
    rootDirs: ['./dist', '../../node_modules/openclaw/dist'],
  },
}, null, 2) + '\n');

const result = spawnSync(process.execPath, [join(root, 'node_modules/typescript/lib/tsc.js'),
  '--project', join(overlay, 'tsconfig.json'), '--pretty', 'false', '--listFiles', ...process.argv.slice(2)],
{ cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
if (result.error) throw result.error;
const lines = result.stdout.split(/\r?\n/).filter(Boolean);
const files = new Set(lines.filter(line => line.startsWith('/') && existsSync(line)).map(path => resolve(path)));
for (const line of lines) if (!files.has(line)) console.error(line);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) process.exit(result.status ?? 1);
for (const { path } of declarations) {
  assert.ok(files.has(join(overlay, 'dist', path)), `Missing declaration overlay input: ${path}`);
  assert.ok(!files.has(join(sdk, 'dist', path)), `Original declaration bypassed overlay: ${path}`);
}
// A successful build must leave the installed SDK byte-identical.
for (const [path, expected] of sources) assert.equal(digest(read(join(sdk, 'dist', path))), expected);
console.log(`Strict TypeScript ${process.argv.includes('--noEmit') ? 'typecheck' : 'build'} PASS; OpenClaw 2026.10.4 declaration overlay verified.`);
