import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const sourcePath = process.argv[2]
  ?? "/home/oa/.npm-global/lib/node_modules/openclaw/dist/openclaw-tools-thu-J91q.mjs";
const source = readFileSync(sourcePath, "utf8");
const tool = source.match(/function createSessionsYieldTool\(opts\) \{[^]*?\n\}/)?.[0];

assert.ok(tool, "sessions_yield implementation missing");
assert.match(tool, /await opts\.onYield\(message, void 0\)/);
assert.match(tool, /return jsonResult\(\{ status: "yielded" \}\)/);
assert.doesNotMatch(tool, /const acknowledgment =/);
assert.doesNotMatch(tool, /\{ acknowledgment \}/);

const createSessionsYieldTool = vm.runInNewContext(`(${tool})`, {
  SessionsYieldToolSchema: {},
  getAgentToolExecutionContext: () => undefined,
  NO_PENDING_CHILD_COMPLETION_ERROR: "no pending completion",
  jsonResult: (value) => value,
  readToolStringParam: (params, key) =>
    typeof params?.[key] === "string" ? params[key].trim() : undefined,
});
let yielded;
const yieldTool = createSessionsYieldTool({
  sessionId: "main-test",
  claimYield: async () => true,
  onYield: async (...args) => { yielded = args; },
});
const result = await yieldTool.execute("call-test", {
  message: "private resume context",
  acknowledgment: "The requested Reminder was created successfully.",
});
assert.equal(yielded[0], "private resume context");
assert.equal(yielded[1], undefined);
assert.equal(result.status, "yielded");
assert.equal(Object.hasOwn(result, "acknowledgment"), false);

console.log("SESSIONS_YIELD_ACKNOWLEDGMENT_SUPPRESSION=PASS");
