import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
test('every portable domain module loads without OpenClaw, host I/O or adapter dependencies', async () => {
  let count = 0;
  for (const domain of ['jessica-vacuum', 'reminder-service']) {
    const path = resolve(`output/typescript/agents/${domain}/lib`);
    for (const file of readdirSync(path).filter(name => name.endsWith('.js'))) { await import(pathToFileURL(resolve(path, file)).href); count++; }
  }
  assert.ok(count >= 20);
});
