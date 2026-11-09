import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
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
assert.equal(pkg.version, '2026.10.10');
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
  ['config-contracts-CaROPwlH.d.ts', '9f1374e4661eeeb8f04297c65daa65db0320512734917d06a0ceba344b6e0246'],
  ['plugin-sdk/plugin-entry.d.ts', 'e7d9cf7464837ea534be87e6096165ee4fb1394a8e40f36c8f791f09d91f9413'],
  ['plugin-sdk/reply-runtime.d.ts', 'a6ff80275d3aa267630badde8a18d3f32e962dcbb0cdd28d37e2152140cfb568'],
  ['plugin-sdk/tool-results.d.ts', 'c8e6062dfe1e952476d012f8ee3e6d877abb24c26925664d6c48e75aba75200c'],
];
for (const [path, expected] of sources) {
  const text = read(join(sdk, 'dist', path));
  assert.equal(digest(text), expected, `Unsupported SDK declaration bytes: ${path}`);
}
// This release splits mutually branded types across declaration files. Keep a
// single declaration graph: mixing original and overlay copies breaks identity.
// Only the optional-label declaration below changes; runtime files stay native.
const declarations = [];
function collectDeclarations(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collectDeclarations(path);
    else if (entry.isFile() && path.endsWith('.d.ts')) {
      declarations.push({ path: relative(join(sdk, 'dist'), path), text: read(path) });
    }
  }
}
collectDeclarations(join(sdk, 'dist'));
declarations.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const declarationInventory = declarations.map(({ path, text }) => [path, digest(text)]);
assert.equal(declarations.length, 376);
assert.equal(digest(JSON.stringify(declarationInventory)), '294e8cb7fcd54a875a2de0cbcaca476efe58c31dbd240f3e6d4342fc7e0652c0',
  'Unsupported SDK declaration graph');
const needle = '  type: "label";\n  targetId: string;\n  label?: string;\n} | {';
const monolith = declarations.find(({ path }) => path === sources[0][0]);
assert.ok(monolith);
assert.equal(monolith.text.split(needle).length, 2, 'The correction must have exactly one target');
monolith.text = monolith.text.replace(needle, needle.replace('label?: string;', 'label?: string | undefined;'));
assert.equal(digest(monolith.text), 'ef224c6c11781b4cdcbfb60b988881e2a5dbb072db58c2320f199883caa1752f');
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
      'openclaw/plugin-sdk/plugin-runtime': ['./dist/plugin-sdk/plugin-runtime.d.ts'],
      'openclaw/plugin-sdk/reply-runtime': ['./dist/plugin-sdk/reply-runtime.d.ts'],
      'openclaw/plugin-sdk/reply-payload': ['./dist/plugin-sdk/reply-payload.d.ts'],
      'openclaw/plugin-sdk/routing': ['./dist/plugin-sdk/routing.d.ts'],
      'openclaw/plugin-sdk/tool-results': ['./dist/plugin-sdk/tool-results.d.ts'],
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
for (const [path] of sources) {
  assert.ok(files.has(join(overlay, 'dist', path)), `Missing declaration overlay input: ${path}`);
}
for (const path of files) assert.ok(!path.startsWith(join(sdk, 'dist') + '/') || !path.endsWith('.d.ts'),
  `Original declaration bypassed overlay: ${path}`);
// A successful build must leave the installed SDK byte-identical.
for (const [path, expected] of declarationInventory) assert.equal(digest(read(join(sdk, 'dist', path))), expected);
if (!process.argv.includes('--noEmit')) {
  // Repository-dependent release roots: native discovery selects the emitted
  // entry directly. Never redirect a package to the legacy dist entry.
  for (const plugin of ['benson-routing', 'plugins/benson-jessica-tool', 'plugins/benson-reminder-tool']) {
    const directory = `integrations/openclaw/${plugin}`;
    const source = json(join(root, directory, 'package.json'));
    const manifest = json(join(root, directory, 'openclaw.plugin.json'));
    assert.equal(source.name, manifest.id);
    assert.ok(existsSync(join(root, options.outDir, directory, 'src/index.js')));
    generate(join(root, options.outDir, directory, 'package.json'), JSON.stringify({
      name: source.name, version: source.version, private: true, type: 'module',
      peerDependencies: { openclaw: pkg.version },
      openclaw: { extensions: ['./src/index.js'] },
    }, null, 2) + '\n');
    generate(join(root, options.outDir, directory, 'openclaw.plugin.json'),
      read(join(root, directory, 'openclaw.plugin.json')));
  }
  // The native routing entry reads this existing domain-owned resource relative
  // to its emitted module. Keep its exact bytes; never load runtime/secret state.
  for (const resource of ['agents/reminder-service/config/recipients.json',
    'agents/jessica-vacuum/config/policy.v1.json', 'agents/jessica-vacuum/config/registry.v1.json']) {
    generate(join(root, options.outDir, resource), read(join(root, resource)));
    assert.equal(digest(read(join(root, options.outDir, resource))), digest(read(join(root, resource))));
  }
  // Both native domain entries consume the single canonical receipt pin.
  const receiptManifest = 'integrations/openclaw/patches/tool-execution-receipts/manifest.json';
  generate(join(root, options.outDir, receiptManifest), read(join(root, receiptManifest)));
  assert.equal(digest(read(join(root, options.outDir, receiptManifest))), digest(read(join(root, receiptManifest))));
  // Preserve the existing Python implementation's realpath-derived resources
  // and state owner. This output depends on the canonical repository closure.
  const executable = 'agents/reminder-service/tools/reminder-service';
  const source = join(root, executable), target = join(root, options.outDir, executable);
  const link = relative(dirname(target), source);
  for (const dependency of [executable, 'agents/reminder-service/libexec/reminder-service-core',
    'agents/reminder-service/lib/reminder_discovery.py']) {
    const info = statSync(join(root, dependency));
    assert(info.isFile() && (info.mode & 0o111) !== 0, `Missing executable dependency: ${dependency}`);
  }
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing) {
    assert(existing.isSymbolicLink(), 'Reminder output executable must be the canonical link');
    assert.equal(readlinkSync(target), link, 'Reminder output executable mapping drift');
  } else {
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(link, target);
  }
  assert.equal(realpathSync(target), realpathSync(source), 'Reminder output executable target drift');
}
console.log(`Strict TypeScript ${process.argv.includes('--noEmit') ? 'typecheck' : 'build'} PASS; OpenClaw ${pkg.version} declaration overlay verified.`);
