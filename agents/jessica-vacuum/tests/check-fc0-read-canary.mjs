import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { readJessicaSensors, readVacuumState, projectHealth, projectMap, projectSensorCollection, projectStatus } from '../lib/ha-read.mjs';
import { assertFreshMap, loadRegistry } from '../lib/registry.mjs';

const DB_PATH = '/home/oa/.openclaw/state/openclaw.sqlite';
const TRANSCRIPT_DB_PATH = '/home/oa/.openclaw/agents/main/agent/openclaw-agent.sqlite';
const BASELINE = process.argv[3];
const REGISTRY = new URL('../config/registry.v1.json', import.meta.url);

function databaseFacts() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const operations = db.prepare("SELECT count(*) AS n FROM plugin_state_entries WHERE plugin_id = 'benson-jessica-tool' AND namespace = 'jessica-operations-v1' AND entry_key LIKE 'request:%'").get().n;
    const device = db.prepare("SELECT value_json FROM plugin_state_entries WHERE plugin_id = 'benson-jessica-tool' AND namespace = 'jessica-operations-v1' AND entry_key = 'device:jessica-vacuum'").get();
    const tasks = db.prepare("SELECT task_id, run_id, status, delivery_status, tool_use_count, last_tool_name, created_at FROM task_runs WHERE agent_id = 'jessica-vacuum' ORDER BY created_at").all();
    return { operations, active: device ? JSON.parse(device.value_json).active : null, tasks };
  } finally { db.close(); }
}

function completionObservations(tasks) {
  const db = new DatabaseSync(TRANSCRIPT_DB_PATH, { readOnly: true });
  try {
    const callsForRun = db.prepare('SELECT session_id, seq, event_json FROM transcript_events WHERE event_json LIKE ?');
    const following = db.prepare('SELECT event_json FROM transcript_events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT 100');
    const observed = new Map();
    for (const task of tasks) {
      const calls = callsForRun.all(`%${task.run_id}%`).filter((row) => {
        const message = JSON.parse(row.event_json).message;
        return message?.role === 'assistant' && message.content?.some?.((part) =>
          part?.type === 'toolCall' && part.name === 'jessica_validate_completion' &&
          part.arguments?.runId === task.run_id);
      });
      if (calls.length !== 1) { observed.set(task.run_id, { validated: false, visibleReply: false }); continue; }
      const call = calls[0];
      const callId = JSON.parse(call.event_json).message.content.find((part) =>
        part?.type === 'toolCall' && part.name === 'jessica_validate_completion' &&
        part.arguments?.runId === task.run_id).id;
      let validated = false;
      let visibleReply = false;
      let resultSeen = false;
      let operation = null;
      for (const row of following.all(call.session_id, call.seq)) {
        const message = JSON.parse(row.event_json).message;
        if (message?.role === 'user' && (message.__openclaw?.senderIdentity ||
            message.__openclaw?.senderId || message.__openclaw?.transport)) break;
        if (message?.role === 'toolResult' && message.toolCallId === callId) {
          resultSeen = true;
          const text = message.content?.find?.((part) => part?.type === 'text')?.text;
          const result = typeof text === 'string' ? JSON.parse(text) : null;
          validated = result?.validated === true;
          operation = validated ? result.result?.operation : null;
        } else if (resultSeen && message?.role === 'assistant' && message.stopReason === 'stop') {
          visibleReply = message.content?.some?.((part) => part?.type === 'text' &&
            part.text.trim().length > 0 && part.text.trim() !== 'NO_REPLY') === true;
          if (visibleReply) break;
        }
      }
      observed.set(task.run_id, { validated, visibleReply, operation });
    }
    return observed;
  } finally { db.close(); }
}

export function checkAfter(before, after, completions) {
  assert.equal(after.operations, before.operations, 'A Jessica physical operation record was added');
  assert.equal(after.active, null, 'A Jessica device transaction is active');
  const expectedOperations = ['status', 'capabilities', 'maintenance'];
  const newTasks = after.tasks.filter((task) => task.created_at > before.latestTaskCreatedAt);
  assert.equal(newTasks.length, 3, 'Expected exactly three fresh Jessica read tasks');
  for (const task of newTasks) {
    assert.equal(task.status, 'succeeded', `Jessica task ${task.task_id} failed`);
    assert.equal(task.delivery_status, 'delivered', `Jessica task ${task.task_id} was not delivered`);
    assert.equal(task.tool_use_count, 1, `Jessica task ${task.task_id} used more than one tool`);
    assert.equal(task.last_tool_name, 'jessica_read', `Jessica task ${task.task_id} used a write tool`);
    assert.equal(completions.get(task.run_id)?.validated, true,
      `Jessica task ${task.task_id} did not pass parent completion validation`);
    assert.equal(completions.get(task.run_id)?.visibleReply, true,
      `Jessica task ${task.task_id} produced no visible parent reply`);
  }
  assert.deepEqual(newTasks.map((task) => completions.get(task.run_id).operation).sort(),
    [...expectedOperations].sort(), 'Jessica read operations differ from the approved canary');
  return newTasks.map(({ task_id: taskId }) => taskId);
}

async function main() {
  const mode = process.argv[2];
  assert(['before', 'after'].includes(mode) && BASELINE,
    'Usage: check-fc0-read-canary.mjs before|after <baseline.json>');
  const registry = loadRegistry(JSON.parse(readFileSync(REGISTRY, 'utf8')));
  for (const name of ['read_status', 'read_capabilities', 'read_maintenance']) {
    assert.notEqual(registry.capabilities.find((item) => item.name === name)?.support, 'disabled');
  }
  const { state, observedAt } = await readVacuumState();
  assertFreshMap(registry, projectMap(state, observedAt), new Date());
  const sensors = await readJessicaSensors();
  const status = projectStatus(state, observedAt);
  status.health = projectHealth(sensors, new Date().toISOString());
  const maintenance = projectSensorCollection(sensors, 'maintenance', new Date().toISOString());
  const filterPercent = maintenance.find((item) => item.name === 'filterPercent');
  const filterHours = maintenance.find((item) => item.name === 'filterHours');
  assert.equal(filterPercent.availability, 'available', 'Filter percent unavailable');
  assert.equal(filterHours.availability, 'available', 'Filter hours unavailable');
  const facts = databaseFacts();
  assert.equal(facts.active, null, 'An unresolved Jessica transaction exists');
  if (mode === 'before') {
    const baseline = { version: '1', recordedAt: new Date().toISOString(), operations: facts.operations,
      latestTaskCreatedAt: Math.max(0, ...facts.tasks.map((task) => task.created_at)) };
    writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ check: 'fc0-read-before', status: 'PASS', baseline: BASELINE,
      mapFingerprint: registry.mapFingerprint, state: status.state, battery: status.batteryLevel,
      filterPercent: filterPercent.value, filterHours: filterHours.value,
      sourceKind: filterPercent.sourceKind }));
  } else {
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
    assert.equal(baseline.version, '1');
    const newTasks = facts.tasks.filter((task) => task.created_at > baseline.latestTaskCreatedAt);
    const taskIds = checkAfter(baseline, facts, completionObservations(newTasks));
    console.log(JSON.stringify({ check: 'fc0-read-after', status: 'PASS', taskIds,
      noPhysicalOperation: true, filterPercent: filterPercent.value, filterHours: filterHours.value }));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ check: 'fc0-read-canary', status: 'FAIL',
      reason: error instanceof Error ? error.message : 'Unknown error' }));
    process.exitCode = 1;
  });
}
