import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(process.argv[2], "utf8");
const unavailable = source.match(/function buildMemorySearchUnavailableResult\([^]*?\n}\n/);
const paused = source.match(/function buildPausedMemoryIndexUnavailableResult\([^]*?\n}\n/);
assert.ok(unavailable && paused, "memory tool result constructors missing");
const context = vm.createContext({});
vm.runInContext(`${unavailable[0]}\n${paused[0]}`, context);
for (const value of [
  vm.runInContext('buildMemorySearchUnavailableResult("private diagnostic", {action:"owner command"})', context),
  vm.runInContext('buildPausedMemoryIndexUnavailableResult({reason:"private diagnostic",owner:"configuration"}, {agentId:"main"})', context),
]) {
  assert.deepEqual(Object.keys(value), ["results"]);
  assert.equal(value.results.length, 0);
}
const normalResult = source.match(/return jsonResult\(\{\s*results: results\.map\([^]*?\n\s*\}\);/);
assert.ok(normalResult, "normal memory result admission missing");
assert.match(normalResult[0], /citations: citationsMode/);
for (const ownerOnly of ["debug", "action:", "warning", "provider:", "model:", "fallback:"]) {
  assert.equal(normalResult[0].includes(ownerOnly), false, `owner-only ${ownerOnly} leaked`);
}
console.log("MEMORY_TOOL_OWNER_DIAGNOSTICS_NOT_ADMITTED=PASS");
