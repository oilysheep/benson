import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dist = "/home/oa/.npm-global/lib/node_modules/openclaw/dist";
const runner = await import(`${dist}/agent-runner.runtime-BVB4SNqA.mjs`);
const admission = await import(`${dist}/reply-admission-ticket-EMIiz0gS.mjs`);
const replyPayload = await import(`${dist}/reply-payload-DXOJ3g20.mjs`);
const announceOutput = await import(`${dist}/subagent-announce-output-CUuHxi5b.mjs`);
const stateDb = await import(`${dist}/openclaw-state-db-DoQEJuhr.mjs`);

const resolveFailureReconciliation =
  runner.__testResolveFailureReconciliation;
const markAgentRunFailureReplyPayload = admission.g;
const setReplyPayloadMetadata = replyPayload.y;
const buildChildCompletionFindings = announceOutput.n;

{
  const verifiedEnvelope = JSON.stringify({
    status: "success",
    verified: true,
    data: { details: "x".repeat(5000) },
    deliveryFailurePolicy: { status: "warning" },
  });
  assert.ok(verifiedEnvelope.length > 4096 && verifiedEnvelope.length < 12000);
  const terminalReply = stateDb.wt({ visibleText: verifiedEnvelope });
  assert.equal(terminalReply.text, verifiedEnvelope, "terminal reply must preserve a bounded complete result");
  const findings = buildChildCompletionFindings([{
    createdAt: 1,
    childSessionKey: "agent:reminder-service:subagent:terminal-test",
    label: "Reminder",
    task: "Reminder",
    execution: { outcome: { status: "ok" }, endedAt: 2 },
    completion: { terminalReply },
  }]);
  assert.ok(findings.includes('"deliveryFailurePolicy"'));
  assert.doesNotMatch(findings, /child result truncated/);
  const oversized = stateDb.wt({ visibleText: "x".repeat(20000) });
  assert.equal(oversized.text.length, 12000, "terminal reply must remain bounded");
  assert.ok(oversized.text.endsWith("…"));
}

function baseRun(overrides = {}) {
  return {
    prompt: "original user request",
    run: {
      agentId: "main",
      sessionKey: "agent:main:whatsapp:direct:test",
      ...overrides.run,
    },
    ...overrides,
  };
}

{
  const verifiedEnvelope = JSON.stringify({
    status: "success",
    domain: "reminder",
    operation: "create",
    verified: true,
    data: { record: { content: "x".repeat(800) } },
    warnings: [],
    error: null,
    pendingContext: null,
  });
  assert.ok(verifiedEnvelope.length > 512 && verifiedEnvelope.length < 4096);
  const findings = buildChildCompletionFindings([{
    createdAt: 1,
    childSessionKey: "agent:reminder-service:subagent:test",
    label: "Reminder",
    task: "Reminder",
    execution: { outcome: { status: "ok" }, endedAt: 2 },
    completion: { resultText: verifiedEnvelope },
  }]);
  assert.match(findings, /\"verified\":true/);
  assert.doesNotMatch(findings, /child result truncated/);
}

{
  const content = "x".repeat(1000);
  const records = [
    { reminderId: "rem-shared", recipientIds: ["ilana", "harel"], content, calendar: { eventId: "event-shared", summary: content, durationMinutes: 30 }, cronJobs: [{ jobId: "job-ilana" }, { jobId: "job-harel" }] },
    { reminderId: "rem-self", recipientIds: ["oren"], content, calendar: { eventId: "event-self", summary: content, durationMinutes: 30 }, cronJobs: [{ jobId: "job-oren" }] },
  ];
  const deliveries = ["ilana", "harel"].map((recipientId) => ({ idempotencyKey: `delivery-${recipientId}`, target: { channel: "whatsapp", accountId: "benson", to: `test-${recipientId}` }, text: content }));
  const verifiedEnvelope = JSON.stringify({ status: "success", domain: "reminder", operation: "create", verified: true, data: { records, reminderIds: ["rem-shared", "rem-self"], transport: { deliveries } }, warnings: [], error: null, pendingContext: null });
  assert.ok(verifiedEnvelope.length > 4096 && verifiedEnvelope.length < 12000);
  const findings = buildChildCompletionFindings([{ createdAt: 1, childSessionKey: "agent:reminder-service:subagent:test-large", label: "Reminder", task: "Reminder", execution: { outcome: { status: "ok" }, endedAt: 2 }, completion: { resultText: verifiedEnvelope } }]);
  for (const fact of ["rem-shared", "rem-self", "delivery-ilana", "delivery-harel"])
    assert.ok(findings.includes(fact), `missing verified fact: ${fact}`);
  assert.doesNotMatch(findings, /child result truncated|additional child completion result omitted/);
}

{
  const raw = "⚠️ Agent run failed (model: openai/gpt-5.6-sol).";
  const payload = markAgentRunFailureReplyPayload({ text: raw });
  const result = resolveFailureReconciliation({
    base: baseRun(),
    payloads: [payload],
    canRetry: true,
    completedSourceDelivery: false,
  });

  assert.equal(result.kind, "retry", "terminal Main failure must reconcile");
  assert.deepEqual(result.payloads, [], "raw terminal failure must be removed");
  assert.equal(result.run.failureReconciliationRetry, true);
  assert.equal(result.run.run.suppressNextUserMessagePersistence, true);
  assert.doesNotMatch(result.run.prompt, /Agent run failed|gpt-5\.6-sol/iu);
  assert.match(result.run.prompt, /Do not replay the original request/iu);

  const runtimeSource = readFileSync(
    `${dist}/agent-runner.runtime-BVB4SNqA.mjs`,
    "utf8",
  );
  assert.match(
    runtimeSource,
    /catch \(error\)[\s\S]*failureResult = await handleReplyAgentRunError[\s\S]*resolveFailureReconciliation/iu,
    "early run exceptions must pass through the same reconciliation gate",
  );
}

{
  const raw = "⚠️ Subagents failed";
  const warning = setReplyPayloadMetadata(
    { text: raw, isError: true },
    { toolErrorWarning: { toolName: "subagents" } },
  );
  const childResult = { text: "child completed successfully" };
  const result = resolveFailureReconciliation({
    base: baseRun(),
    payloads: [childResult, warning],
    canRetry: true,
    completedSourceDelivery: false,
  });

  assert.equal(result.kind, "retry");
  assert.deepEqual(result.payloads, [childResult]);
  assert.doesNotMatch(result.run.prompt, /Subagents failed/iu);
  assert.match(result.run.prompt, /not evidence that a child task failed/iu);
}

{
  const completionDelivery = {
    taskId: "task-with-successful-mutation",
    childOutcome: "ok",
    deliveryState: "pending",
  };
  const payload = markAgentRunFailureReplyPayload({ text: "private failure" });
  const result = resolveFailureReconciliation({
    base: baseRun({ completionDelivery }),
    payloads: [payload],
    canRetry: true,
    completedSourceDelivery: false,
  });

  assert.equal(result.kind, "retry");
  assert.deepEqual(result.run.completionDelivery, completionDelivery);
  assert.notEqual(result.run.prompt, "original user request");
  assert.match(result.run.prompt, /verify every relevant durable surface/iu);
  assert.match(result.run.prompt, /Reminder, Automation, and Calendar/iu);
  assert.match(result.run.prompt, /at most one bounded retry/iu);
}

{
  const payload = markAgentRunFailureReplyPayload({ text: "private failure" });
  const result = resolveFailureReconciliation({
    base: baseRun({ failureReconciliationRetry: true }),
    payloads: [payload],
    canRetry: true,
    completedSourceDelivery: false,
  });

  assert.equal(result.kind, "suppress", "ambiguous repeated failure must fail closed");
  assert.deepEqual(result.payloads, []);
  assert.equal("run" in result, false, "reconciliation must be bounded to one retry");
}

console.log("openclaw main failure reconciliation regressions: 7 passed");
