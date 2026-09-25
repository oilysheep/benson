import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const [runnerPath, registryPath, openclawToolsPath, agentToolsPath] = process.argv.slice(2);
for (const value of [runnerPath, registryPath, openclawToolsPath, agentToolsPath]) {
  assert.ok(value, "four installed OpenClaw source paths are required");
}
const runner = readFileSync(runnerPath, "utf8");
const registry = readFileSync(registryPath, "utf8");
const openclawTools = readFileSync(openclawToolsPath, "utf8");
const agentTools = readFileSync(agentToolsPath, "utf8");

const mismatch = runner.match(/if \(error instanceof QuestionDispatchRefusedError\) \{[^]*?\n\t\t\}/);
assert.ok(mismatch, "question caller-mismatch branch missing");
assert.match(mismatch[0], /return \{ handled: false \}/);
assert.doesNotMatch(mismatch[0], /The answer was not sent|Control UI|markReplyPayloadForSourceSuppressionDelivery/);

const terminal = registry.match(/function shouldAutoDeliverTaskTerminalUpdate\(task\) \{[^]*?\n\}/);
assert.ok(terminal, "task terminal delivery policy missing");
assert.match(terminal[0], /if \(task\.runtime === "subagent"\) return false/);
assert.doesNotMatch(terminal[0], /task\.status === "cancelled"/);

const include = openclawTools.match(/function shouldIncludeAskUserToolForOpenClawTools\(params\) \{[^]*?\n\}/);
assert.ok(include, "ask_user admission policy missing");
assert.match(include[0], /provenanceKind !== "external_user"/);
assert.match(openclawTools, /pluginToolDenylist: options\?\.pluginToolDenylist,\n\t+inputProvenance: options\?\.inputProvenance/);
assert.match(agentTools, /agentAccountId: options\?\.agentAccountId,\n\t+inputProvenance: options\?\.inputProvenance/);

const terminalPolicy = vm.runInNewContext(`(${terminal[0]})`, {
  isTerminalTaskStatus: (status) => ["completed", "failed", "cancelled"].includes(status),
});
assert.equal(terminalPolicy({ runtime: "subagent", status: "cancelled", deliveryStatus: "pending" }), false);
assert.equal(terminalPolicy({ runtime: "subagent", status: "completed", deliveryStatus: "pending" }), false);
assert.equal(terminalPolicy({ runtime: "acp", status: "completed", deliveryStatus: "pending" }), true);
assert.equal(terminalPolicy({ runtime: "acp", status: "completed", deliveryStatus: "delivered" }), false);

const askPolicy = vm.runInNewContext(`(${include[0]})`, {
  shouldIncludePrimarySessionToolForOpenClawTools: (name) => name === "ask_user",
});
assert.equal(askPolicy({ inputProvenance: { kind: "external_user" } }), true);
assert.equal(askPolicy({ inputProvenance: { kind: "internal_completion" } }), false);

const replySource = runner.match(/async function runReplyQuestionInput\(params\) \{[^]*?\n\}/);
assert.ok(replySource, "question reply admission function missing");
class QuestionDispatchRefusedError extends Error {}
class QuestionAnswerUnconfirmedError extends Error {}
let claimResult = true;
let claimCalls = 0;
let consumed = 0;
const runReplyQuestionInput = vm.runInNewContext(`(${replySource[0]})`, {
  resolveInboundReplyToolAuthorityOverlay: () => ({ caller: "current" }),
  resolveFollowupAbortSignal: () => undefined,
  resolveReplyOperationRunState: (opts) => opts.state,
  claimPendingAgentQuestionAnswerFromCaller: async () => {
    claimCalls += 1;
    if (claimResult instanceof Error) throw claimResult;
    return claimResult;
  },
  QuestionDispatchRefusedError,
  QuestionAnswerUnconfirmedError,
  admitFollowupRunLifecycle: async () => {},
  completeFollowupRunLifecycle: () => { consumed += 1; },
  logVerbose: () => {},
  markReplyPayloadForSourceSuppressionDelivery: (payload) => payload,
});
const replyParams = (kind = "external_user") => ({
  sessionKey: "main:test",
  commandBody: "ordinary answer",
  opts: { state: {} },
  followupRun: { run: { inputProvenance: { kind } } },
});
let params = replyParams();
assert.equal((await runReplyQuestionInput(params)).handled, true);
assert.equal(params.opts.state.admission.status, "accepted");
assert.equal(consumed, 1);
assert.equal(claimCalls, 1);
for (const noQuestion of ["absent", "expired", "cancelled"]) {
  claimResult = false;
  params = replyParams();
  assert.equal((await runReplyQuestionInput(params)).handled, false, noQuestion);
  assert.equal(consumed, 1, noQuestion);
}
claimResult = new QuestionDispatchRefusedError("different caller");
params = replyParams();
assert.equal((await runReplyQuestionInput(params)).handled, false);
assert.equal(consumed, 1);
const beforeInternal = claimCalls;
params = replyParams("internal_completion");
assert.equal((await runReplyQuestionInput(params)).handled, false);
assert.equal(claimCalls, beforeInternal);
assert.equal(consumed, 1);

console.log("QUESTION_LIFECYCLE_ADMISSION=PASS");
