import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assertion, boundedCopy, fail, identifier, plain } from '../../core/value.js';
import { retainToolExecutionEvidence, copyToolExecutionReceipt, type ToolExecutionCoverage, type ToolExecutionReceipt } from '../../core/tool-execution-evidence.js';
import { readToolExecutionEvidence, type ToolExecutionEvidence } from '../../core/tool-execution-evidence.js';
import { MAX_NATIVE_TOOL_CALLS, type NativeToolObservation, type NativeDomainCompletionInput } from '../../core/completion.js';
import { MAX_TRANSCRIPT_HYDRATION_EVENTS } from '../../core/request-control.js';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

const contract = 'openclaw.tool-execution-evidence.v1';
type Watch = (sessionKey: string, receive: (event: unknown) => void) => () => void;

/** Private native-hook/domain-witness composition. Receipts remain the sole
 * enumeration/original-result authority. The registry holds only bounded live
 * invocations, not another evidence store or execution/lifecycle owner. */
export function createOpenClawDomainRunCollector(api: { on: OpenClawPluginApi['on'];
  lifecycle: Pick<OpenClawPluginApi['lifecycle'], 'signal' | 'onDispose'> }, options: {
  agentId: 'reminder-service' | 'jessica-vacuum'; tools: readonly string[];
}) {
  const signal = api.lifecycle.signal;
  if (!signal || !api.lifecycle.onDispose) fail('native_plugin_lifecycle_unavailable');
  const tools = new Set(options.tools), agentId = options.agentId;
  if (!tools.size || tools.size !== options.tools.length || [...tools].some(name => !identifier(name))) fail('native_domain_tools_invalid');
  type Call = { runId: string; sessionId: string; name: string; captured: boolean; value?: unknown;
    verify?: (args: unknown, value: unknown) => unknown; after?: NativeToolObservation['after'] };
  type Scope = { sessionKey: string; sourceCurrent(): unknown; invalid: boolean; completed: boolean;
    released: boolean; runId?: string; sessionId?: string; calls: Map<string, Call>;
    terminal?: NativeDomainCompletionInput['terminal'] };
  const scopes = new Map<string, Scope>();
  let live = true;
  const current = (scope: Scope) => {
    signal.throwIfAborted();
    if (!live || scope.invalid) fail('native_domain_collection_retired');
    assertion(scope.sourceCurrent(), 'native_domain_source_custody');
  };
  const executing = (scope: Scope) => {
    current(scope);
    if (scope.released || scope.completed) fail('native_domain_execution_retired');
  };
  const pin = (scope: Scope, context: { agentId?: string; sessionKey?: string; sessionId?: string; runId?: string }) => {
    if (context.agentId !== agentId || context.sessionKey !== scope.sessionKey ||
      !identifier(context.runId) || !identifier(context.sessionId) ||
      scope.runId !== undefined && scope.runId !== context.runId ||
      scope.sessionId !== undefined && scope.sessionId !== context.sessionId) fail('native_domain_identity_mismatch');
    scope.runId = context.runId; scope.sessionId = context.sessionId;
  };
  api.on('before_tool_call', (event, context) => {
    const scope = context.sessionKey ? scopes.get(context.sessionKey) : undefined;
    if (!scope) return;
    try {
      executing(scope); pin(scope, context);
      if (scope.terminal || !identifier(context.toolCallId) || event.toolCallId !== context.toolCallId ||
        event.runId !== context.runId || !tools.has(event.toolName) || scope.calls.has(context.toolCallId) ||
        scope.calls.size >= MAX_NATIVE_TOOL_CALLS) fail('native_domain_call_unverified');
      scope.calls.set(context.toolCallId, { runId: scope.runId!, sessionId: scope.sessionId!, name: event.toolName, captured: false });
      return;
    } catch {
      scope.invalid = true;
      // Native policy must veto on error; observation-hook exceptions alone
      // would be logged and ignored by the host.
      return { block: true, blockReason: 'Native domain invocation evidence unavailable.' };
    }
  });
  api.on('after_tool_call', (event, context) => {
    const scope = context.sessionKey ? scopes.get(context.sessionKey) : undefined;
    if (!scope) return;
    try {
      executing(scope); pin(scope, context);
      const call = context.toolCallId ? scope.calls.get(context.toolCallId) : undefined;
      if (scope.terminal || !call || call.after || call.name !== event.toolName ||
        event.toolCallId !== context.toolCallId || event.runId !== context.runId) fail('native_domain_after_unverified');
      // Sanitized after payloads never become original result evidence.
      call.after = { runId: context.runId, callId: context.toolCallId, error: event.error, value: undefined };
    } catch { scope.invalid = true; }
  });
  api.on('agent_end', (event, context) => {
    const scope = context.sessionKey ? scopes.get(context.sessionKey) : undefined;
    if (!scope) return;
    try {
      executing(scope); pin(scope, context);
      if (scope.terminal || !Array.isArray(event.messages) || event.messages.length > MAX_TRANSCRIPT_HYDRATION_EVENTS ||
        typeof event.success !== 'boolean') fail('native_domain_terminal_unverified');
      // The existing Completion owner captures the selected native carrier
      // fields; do not clone/mutate arbitrary SDK wrappers here.
      scope.terminal = { runId: context.runId, sessionKey: context.sessionKey,
        sessionId: context.sessionId, success: event.success, messages: event.messages };
    } catch { scope.invalid = true; }
  });
  api.lifecycle.onDispose(() => { live = false; scopes.clear(); });
  return Object.freeze({ begin(sessionKey: string, sourceCurrent: () => unknown) {
    signal.throwIfAborted();
    if (!live || !sessionKey.startsWith(`agent:${agentId}:subagent:`) || scopes.has(sessionKey) || scopes.size >= 8) fail('native_domain_scope_unavailable');
    const scope: Scope = { sessionKey, sourceCurrent, invalid: false, completed: false, released: false, calls: new Map() };
    current(scope); scopes.set(sessionKey, scope);
    return Object.freeze({
      assertExecuting() { executing(scope); },
      record(context: { agentId?: string; sessionKey?: string; sessionId?: string }, callId: string, name: string,
        value: unknown, verify: (args: unknown, value: unknown) => unknown) {
        try {
          executing(scope);
          const call = scope.calls.get(callId);
          if (scope.terminal || !call || call.captured || context.agentId !== agentId || context.sessionKey !== sessionKey ||
            context.sessionId !== call.sessionId || call.name !== name || typeof verify !== 'function') fail('native_domain_witness_unverified');
          call.value = boundedCopy(value); call.verify = verify; call.captured = true;
        } catch (error) { scope.invalid = true; throw error; }
      },
      complete(identity: ToolExecutionCoverage['identity'], evidence: ToolExecutionEvidence) {
        executing(scope);
        if (!scope.terminal || identity.runId !== scope.runId || identity.sessionId !== scope.sessionId ||
          identity.agentId !== agentId || identity.sessionKey !== sessionKey) fail('native_domain_terminal_unverified');
        const coverage = readToolExecutionEvidence(evidence, identity);
        if (coverage.receipts.length !== scope.calls.size) fail('native_domain_calls_omitted');
        const observations = coverage.receipts.map(receipt => {
          const call = scope.calls.get(receipt.callId);
          if (!call || !call.captured || !call.after || call.name !== receipt.name) fail('native_domain_witness_unverified');
          return { tool: { runId: call.runId, sessionKey, sessionId: call.sessionId, callId: receipt.callId,
            name: call.name, value: boundedCopy(call.value) }, after: { ...call.after } };
        });
        scope.completed = true;
        return { observations, terminal: { ...scope.terminal }, custody: { assertCurrent() { current(scope); } },
          validateTool(tool: Readonly<NativeToolObservation['tool']>, receipt?: Readonly<ToolExecutionReceipt>) {
            current(scope);
            const call = scope.calls.get(tool.callId);
            if (!receipt || !call?.verify || tool.runId !== scope.runId || tool.sessionKey !== sessionKey ||
              tool.sessionId !== scope.sessionId || tool.name !== call.name || receipt.callId !== tool.callId || receipt.name !== tool.name ||
              !isDeepStrictEqual(boundedCopy(tool.value), call.value)) fail('native_domain_witness_unverified');
            assertion(call.verify(receipt.executionArgs, tool.value), 'native_domain_witness_async');
          } };
      },
      release() {
        current(scope);
        if (!scope.completed) fail('native_domain_terminal_unverified');
        scope.released = true;
        if (scopes.get(sessionKey) === scope) scopes.delete(sessionKey);
      },
      discard() { scope.invalid = true; if (scopes.get(sessionKey) === scope) scopes.delete(sessionKey); },
    });
  } });
}
/** The sole patch-specific adapter. Replace Watch with an official provider here. */
export async function observeOpenClawToolExecution(sessionKey: string, assertCurrent: () => unknown, manifestUrl: URL) {
  // This public SDK entry has no declarations on 2026.10.4. Validate at runtime;
  // no imports of hashed internals or ambient declarations.
  const entry = 'openclaw/plugin-sdk/agent-core';
  const root = new URL('../../', import.meta.resolve(entry));
  const manifest: unknown = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  if (!plain(manifest) || manifest.package !== 'openclaw' || manifest.version !== '2026.10.4' || manifest.contract !== contract || !Array.isArray(manifest.files) || manifest.files.length !== 5) fail('native_receipt_pin_invalid');
  const installed: unknown = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  if (!plain(installed) || installed.version !== manifest.version) fail('native_receipt_version_mismatch');
  for (const file of manifest.files) {
    if (!plain(file) || typeof file.path !== 'string' || !file.path.startsWith('dist/') || file.path.split('/').includes('..') || typeof file.afterSha256 !== 'string') fail('native_receipt_pin_invalid');
    if (createHash('sha256').update(readFileSync(new URL(file.path, root))).digest('hex') !== file.afterSha256) fail('native_receipt_source_drift');
  }
  const sdk: unknown = await import(entry);
  if (!plain(sdk) && (typeof sdk !== 'object' || sdk === null)) fail('native_receipt_extension_missing');
  const provider: unknown = Reflect.get(sdk, 'toolExecutionEvidenceProvider');
  if (!plain(provider) || provider.contract !== contract || provider.version !== '2026.10.4') fail('native_receipt_version_mismatch');
  const watch: unknown = Reflect.get(sdk, 'observeToolExecutionEvidence');
  if (typeof watch !== 'function' || !identifier(sessionKey)) fail('native_receipt_extension_missing');
  const runs = new Map<object, { identity: ToolExecutionCoverage['identity']; receipts: ToolExecutionReceipt[];
    seal: ToolExecutionCoverage['seal'] | null; current: (() => unknown) | null; invalid: boolean }>();
  let disposed = false;
  const lifetime = new AbortController();
  const waiters = new Map<string, Set<() => void>>();
  const disposeNative: unknown = (watch as Watch)(sessionKey, raw => {
    assertion(assertCurrent(), 'native_receipt_custody');
    if (disposed || !plain(raw) || raw.contract !== contract || !plain(raw.token) || !plain(raw.identity)) fail('native_receipt_event_invalid');
    const identity = raw.identity;
    if (!['runId', 'sessionKey', 'sessionId', 'agentId'].every(key => identifier(identity[key])) || identity.sessionKey !== sessionKey) fail('native_receipt_identity_invalid');
    if (raw.type === 'begin') {
      if (runs.has(raw.token) || runs.size >= 8) fail('native_receipt_begin_invalid');
      runs.set(raw.token, { identity: identity as ToolExecutionCoverage['identity'], receipts: [], seal: null, current: null, invalid: false }); return;
    }
    const run = runs.get(raw.token);
    if (!run || run.seal) { if (run) run.invalid = true; fail('native_receipt_late_event'); }
    if (!isDeepStrictEqual(boundedCopy(identity), boundedCopy(run.identity))) { run.invalid = true; fail('native_receipt_identity_changed'); }
    if (raw.type === 'receipt') {
      if (!plain(raw.receipt) || run.receipts.length >= 64) { run.invalid = true; fail('native_receipt_limit'); }
      // Runtime schema and coverage checks are centralized in the stable owner.
      run.receipts.push(copyToolExecutionReceipt(raw.receipt));
    } else if (raw.type === 'seal' && typeof raw.complete === 'boolean' && typeof raw.count === 'number' && typeof raw.attempts === 'number' && typeof raw.isCurrent === 'function') {
      run.receipts.sort((a, b) => a.ordinal - b.ordinal);
      run.seal = { complete: raw.complete, count: raw.count, attempts: raw.attempts };
      run.current = raw.isCurrent as () => unknown;
      for (const resolve of waiters.get(run.identity.runId) ?? []) resolve();
    } else { run.invalid = true; fail('native_receipt_event_invalid'); }
  });
  if (typeof disposeNative !== 'function') fail('native_receipt_subscription_invalid');
  let subscribed = true;
  const unsubscribe = () => { if (subscribed) { subscribed = false; (disposeNative as () => void)(); } };
  return {
    async waitForSettlement(runId: string, sourceSignal: AbortSignal) {
      const signal = AbortSignal.any([sourceSignal, lifetime.signal]);
      signal.throwIfAborted();
      if ([...runs.values()].some(run => run.identity.runId === runId && run.seal)) return;
      if (disposed || !subscribed) fail('native_receipt_subscription_closed');
      await new Promise<void>((resolve, reject) => {
        const done = () => { signal.removeEventListener('abort', abort); waiters.get(runId)?.delete(done); resolve(); };
        const abort = () => { waiters.get(runId)?.delete(done); reject(signal.reason); };
        const group = waiters.get(runId) ?? new Set<() => void>(); group.add(done); waiters.set(runId, group);
        signal.addEventListener('abort', abort, { once: true });
      });
    },
    inspectIdentity(runId: string) {
      assertion(assertCurrent(), 'native_receipt_custody');
      const matches = [...runs.values()].filter(run => run.identity.runId === runId);
      if (disposed || matches.length !== 1) fail('native_receipt_run_ambiguous');
      return Object.freeze({ ...matches[0]!.identity });
    },
    evidence(runId: string) {
      const matches = [...runs.values()].filter(run => run.identity.runId === runId);
      if (matches.length !== 1) fail('native_receipt_run_ambiguous');
      const run = matches[0]!;
      return retainToolExecutionEvidence(() => {
        if (disposed || run.invalid || !run.seal) fail('native_receipt_unsealed');
        if (run.seal.complete) assertion(run.current?.(), 'native_receipt_retired');
        return { version: 1, identity: run.identity, receipts: run.receipts, seal: run.seal };
      }, assertCurrent);
    },
    /** Release the native subscription after settlement. Sealed read-only
     * custody remains source-guarded and collectable with its consumer; no new
     * Run may be observed. This is not disposal or an execution grant. */
    close() {
      assertion(assertCurrent(), 'native_receipt_custody');
      if (disposed || [...runs.values()].some(run => !run.seal)) fail('native_receipt_unsealed');
      unsubscribe();
      lifetime.abort(new Error('native_receipt_subscription_closed'));
    },
    dispose() { disposed = true; lifetime.abort(new Error('native_receipt_disposed')); unsubscribe(); runs.clear(); },
  };
}
