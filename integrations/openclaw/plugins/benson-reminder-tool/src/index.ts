import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { jsonResult } from 'openclaw/plugin-sdk/tool-results';
import { PublicSchemas, parseRequest, type ToolName } from '../../../../../agents/reminder-service/lib/schemas.js';
import type { Dependencies } from '../../../../../agents/reminder-service/lib/service.js';
import { assertInvocationCurrent } from '../../../benson-routing/core/invocation.js';
import { currentNativeTurn } from '../../../benson-routing/adapters/openclaw/response.js';
import type { NativeOriginalUserTurns } from '../../../benson-routing/adapters/openclaw/conversation.js';
import { createOpenClawDomainRunCollector, observeOpenClawToolExecution } from '../../../benson-routing/adapters/openclaw/tool-execution-evidence.js';
import { readToolExecutionEvidence } from '../../../benson-routing/core/tool-execution-evidence.js';
import { fail, synchronous } from '../../../benson-routing/core/value.js';
import { loadCanonicalIdentityContract } from './identity.js';
import { createReminderTransaction } from './runner.js';
import { createReminderTaskToolFactory, createReminderToolFactory } from './tool.js';
import { collectReminderRunEffects, runReminderNativeTask } from './completion.js';

export default definePluginEntry({
  id: 'benson-reminder-tool', name: 'Benson Reminder Tool',
  description: 'Existing Reminder transactions and native Task entry with controlled Completion.',
  register(api) {
    if (api.registrationMode !== 'full') return;
    // Native source capture relocates modules. Anchor existing canonical
    // resources to the configured package root, never the captured JS URL.
    const identities = loadCanonicalIdentityContract(api.resolvePath('../../../../agents/reminder-service/config/recipients.json'));
    const transaction = createReminderTransaction({ servicePath: api.resolvePath('../../../../agents/reminder-service/tools/reminder-service') });
    const receiptManifest = pathToFileURL(api.resolvePath('../../patches/tool-execution-receipts/manifest.json'));
    const tools = Object.keys(PublicSchemas) as ToolName[];
    const collector = createOpenClawDomainRunCollector(api, { agentId: 'reminder-service', tools });
    // Transient registration dependencies only; the collector owns native
    // observations, the transaction owns domain execution and durable state.
    type Work = { source: Dependencies; current: Parameters<typeof createReminderToolFactory>[0]['current'];
      assertExecuting(): void; record: ReturnType<typeof collector.begin>['record'] };
    const active = new Map<string, Work>();
    api.lifecycle.onDispose?.(() => active.clear());
    for (const name of tools) api.registerTool({ contextVersion: 2, create(context) {
      const work = context.sessionKey ? active.get(context.sessionKey) : undefined;
      if (context.agentId !== 'reminder-service' || !work) return null;
      const guarded = { ...context, assertInvocationCurrent() {
        synchronous(context.assertInvocationCurrent(), 'reminder_tool_authority_must_be_synchronous');
        work.assertExecuting();
      } };
      return createReminderToolFactory({ name, source: work.source, ...work.current ? { current: work.current } : {},
        jsonResult(value, verify, callId) { work.record(context, callId, name, value, verify); return jsonResult(value); },
      })(guarded);
    } }, { name, optional: true });
    api.registerTool({ contextVersion: 2, create(context) {
      if (context.agentId !== 'main') return null;
      let originalHistory: NativeOriginalUserTurns | undefined;
      const tool = createReminderTaskToolFactory({ identities, transaction, resultVersion: 3,
        jsonResult(value, callId, assertCompletion) {
          const turn = currentNativeTurn(api, context);
          turn.record(context, callId, value, () => { turn.assertCurrent(); assertCompletion?.(); });
          return jsonResult(value);
        },
        task: {
          source: ctx => currentNativeTurn(api, ctx).source(ctx),
          async originalUserTurns() {
            const history = originalHistory;
            if (!history) fail('reminder_original_context_unavailable');
            history.assertCurrent();
            return { turns: history.turns.map(turn => ({ text: turn.text })), assertCurrent: history.assertCurrent };
          },
          async run(request, work) {
            assertInvocationCurrent(work.deps.authority);
            const turn = currentNativeTurn(api, context), caller = turn.caller(context, work.callId);
            const originals = await turn.originalUserTurns(context);
            originalHistory = originals;
            const prior = await originals.acquireTaskResults(work.callId);
            prior.assertCurrent(); originals.assertCurrent(); assertInvocationCurrent(work.deps.authority);
            // Semantic pending selection/clearing is not accepted yet. Retain
            // every original result; no null carrier silently clears a bundle.
            if (prior.results.some(item => item.result.pendingContext !== null)) fail('reminder_pending_continuation_not_enabled');
            const retainedCurrent = () => { turn.assertCurrent(); originals.assertCurrent(); };
            const sessionKey = `agent:reminder-service:subagent:${randomUUID()}`;
            const scope = collector.begin(sessionKey, retainedCurrent);
            let provider: Awaited<ReturnType<typeof observeOpenClawToolExecution>> | undefined;
            try {
              provider = await observeOpenClawToolExecution(sessionKey, retainedCurrent,
                receiptManifest);
              assertInvocationCurrent(work.deps.authority); retainedCurrent();
              const execution = { source: { ...work.deps, authority: { signal: api.lifecycle.signal!, assertCurrent: retainedCurrent } },
                current: work.source, assertExecuting() { assertInvocationCurrent(work.deps.authority); scope.assertExecuting(); },
                record: scope.record };
              if (active.size >= 8 || active.has(sessionKey)) fail('reminder_native_scope_unavailable');
              active.set(sessionKey, execution);
              const evidence = provider;
              const settled = await runReminderNativeTask(request, work, { runtime: api.runtime.subagent,
                sessionKey, caller, toolsAlsoAllow: tools, executionEvidence: evidence, resultVersion: 3,
                // Original text remains quoted data. Native agent guidance and
                // deterministic domain checks retain all execution authority.
                message: JSON.stringify({ request: request.request, contextId: work.source.context.conversation.conversationRef,
                  currentEvidenceId: work.source.context.current.entryId, originalUserTurns: originals.turns.map(item => ({ text: item.text })) }),
                observe(runId) {
                  const identity = evidence.inspectIdentity(runId), native = evidence.evidence(runId);
                  const observed = scope.complete(identity, native), selected = observed.observations.at(-1);
                  if (!selected) fail('reminder_reasoning_only_producer_not_enabled');
                  const coverage = readToolExecutionEvidence(native, identity), receipt = coverage.receipts.at(-1);
                  if (!receipt || receipt.callId !== selected.tool.callId) fail('reminder_native_receipt_missing');
                  const operation = parseRequest(selected.tool.name as ToolName, receipt.executionArgs).operation;
                  return { ...selected, preceding: observed.observations.slice(0, -1), terminal: observed.terminal,
                    custody: observed.custody, validateTool: observed.validateTool, operation,
                    ...collectReminderRunEffects(observed.observations.map(item => item.tool), work.callId) };
                } });
              scope.release(); evidence.close(); return settled;
            } catch (error) { scope.discard(); provider?.dispose(); throw error; }
            finally { active.delete(sessionKey); }
          },
        },
      })(context);
      if (!tool || Array.isArray(tool)) return null;
      return { ...tool, async execute(callId, request, signal, onUpdate) {
        // Fence the deterministic zero-Run list path before transaction access,
        // as well as the agentic path's later original-source checks.
        currentNativeTurn(api, context).caller(context, callId);
        return tool.execute(callId, request, signal, onUpdate);
      } };
    } }, { name: 'reminder_task', optional: true });
  },
});
