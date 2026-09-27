import { isDeepStrictEqual } from 'node:util';
import { validateResult } from '../../../../../agents/jessica-vacuum/lib/results.mjs';
import { EXECUTE_OPERATIONS } from '../../../../../agents/jessica-vacuum/lib/schemas.mjs';
import { normalizeLegacyTaskResult } from '../../../benson-routing/envelope.mjs';

const CHILD = 'jessica-vacuum';
const DOMAIN_TOOLS = new Set(['jessica_read', 'jessica_execute']);
const PARAMETERS = Object.freeze({
  type: 'object', properties: { runId: { type: 'string', minLength: 1, maxLength: 160 } },
  required: ['runId'], additionalProperties: false,
});

function textOf(message, allowThinking = false) {
  const parts = message?.content;
  if (!Array.isArray(parts) || !parts.every((part) =>
    part?.type === 'text' ? typeof part.text === 'string' : allowThinking && part?.type === 'thinking')) {
    return null;
  }
  const textParts = parts.filter((part) => part.type === 'text');
  return textParts.length === 1 ? textParts[0].text : null;
}

function parsed(text) {
  if (typeof text !== 'string' || text.length > 64_000) throw new Error('Result text is missing or too large');
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Result is not an object');
  return value;
}

function latestExternalTurn(entries) {
  const inbound = entries.filter((entry) => entry.role === 'user' &&
    (entry.message?.__openclaw?.senderIdentity ||
      entry.message?.__openclaw?.senderId || entry.message?.__openclaw?.transport) &&
    Number.isSafeInteger(entry.message?.timestamp));
  return inbound.at(-1)?.message.timestamp ?? null;
}

function isDomainResult(entry) {
  return entry.role === 'toolResult' && DOMAIN_TOOLS.has(entry.message?.toolName) ||
    entry.role === 'custom' && entry.message?.customType === 'openclaw.nested-tool.v1' &&
      DOMAIN_TOOLS.has(entry.message?.details?.toolName);
}

function matchingToolResult(entries, runId) {
  const results = entries.filter(isDomainResult);
  if (!results.length) throw new Error('No deterministic Jessica tool result');
  const selected = results.at(-1);
  if (selected.role === 'custom') {
    const detail = selected.message.details;
    const parentCall = entries.find((entry) => entry.seq < selected.seq &&
      entry.entryId === detail.afterEntryId && entry.role === 'assistant' &&
      entry.message?.content?.some?.((part) => part?.type === 'toolCall' &&
        part.id === detail.parentToolCallId && part.name === 'exec'));
    const outer = entries.find((entry) => entry.seq > selected.seq &&
      entry.role === 'toolResult' && entry.message?.toolName === 'exec' &&
      entry.message?.toolCallId === detail.parentToolCallId && entry.message?.isError !== true);
    if (detail.runId !== runId || typeof detail.toolCallId !== 'string' || !detail.toolCallId ||
        detail.isError !== false || !parentCall || !outer) {
      throw new Error('Jessica nested tool provenance is incomplete');
    }
    const authoritative = parsed(textOf(detail.result));
    const outerResult = parsed(textOf(outer.message));
    if (!isDeepStrictEqual(authoritative, detail.result?.details) ||
        outerResult.status !== 'completed' ||
        !isDeepStrictEqual(outerResult.value, authoritative) ||
        !(isDeepStrictEqual(outer.message.details, outerResult) ||
          outer.message.details?.persistedDetailsTruncated === true)) {
      throw new Error('Jessica nested tool result differs from native execution');
    }
    return { entry: outer, result: authoritative };
  }
  const callId = selected.message.toolCallId;
  if (typeof callId !== 'string' || !callId || selected.message.isError === true) {
    throw new Error('Jessica tool result is incomplete');
  }
  const called = entries.some((entry) => entry.seq < selected.seq && entry.role === 'assistant' &&
    entry.message?.content?.some?.((part) => part?.type === 'toolCall' && part.id === callId &&
      part.name === selected.message.toolName));
  if (!called) throw new Error('Jessica tool result has no matching native call');
  return { entry: selected, result: parsed(textOf(selected.message)) };
}

function validateClarification(final, tool, entries, now) {
  validateResult(tool, null, now);
  validateResult(final, null, now);
  if (final.status !== 'clarification_required' || final.operation !== 'clean' ||
      tool.status !== 'success' || tool.operation !== 'rooms' ||
      entries.some((entry) => isDomainResult(entry) &&
        (entry.message?.toolName ?? entry.message?.details?.toolName) === 'jessica_execute')) {
    throw new Error('Clarification has no safe room evidence');
  }
  const rooms = new Map(tool.data.rooms.filter((room) => room.enabled)
    .map((room) => [room.slug, room.label]));
  const candidates = final.data.candidates;
  if (!['איזה חדר התכוונת?', 'Which room did you mean?'].includes(final.data.question) ||
      !/^[A-Za-z0-9_-]{1,64}$/u.test(final.pendingContext.clarificationId) ||
      Date.parse(final.pendingContext.expiresAt) > now.getTime() + 30 * 60_000 ||
      new Set(candidates.map((item) => item.room)).size !== candidates.length ||
      candidates.some((item) => rooms.get(item.room) !== item.label)) {
    throw new Error('Clarification candidates differ from verified rooms');
  }
  return final;
}

function validateDisabledControl(final, tool, entries, now) {
  validateResult(tool, null, now);
  validateResult(final, null, now);
  if (final.status !== 'failure' || !EXECUTE_OPERATIONS.includes(final.operation) ||
      final.verified !== false || final.data !== null ||
      final.error?.code !== 'CONTROL_NOT_ENABLED' || final.error?.sideEffects !== 'none' ||
      final.error?.retryMode !== 'none' || tool.status !== 'success' ||
      tool.operation !== 'capabilities' ||
      tool.data.capabilities.some((capability) =>
        EXECUTE_OPERATIONS.includes(capability.name) && capability.support === 'verified') ||
      tool.data.capabilities.some((capability) =>
        capability.name.startsWith('clean_') && capability.support === 'verified') ||
      entries.some((entry) => isDomainResult(entry) &&
        (entry.message?.toolName ?? entry.message?.details?.toolName) === 'jessica_execute')) {
    throw new Error('Control refusal is not supported by current capability evidence');
  }
  return final;
}

export async function validateJessicaCompletion({ runId, parentSessionKey, runs, readMessages,
  now = new Date() }) {
  if (typeof runId !== 'string' || !runId || typeof parentSessionKey !== 'string' ||
      !parentSessionKey.startsWith('agent:main:')) throw new Error('Native correlation is unavailable');
  const task = runs.filter((item) => item.runId === runId && item.runtime === 'subagent' &&
    item.agentId === CHILD && item.status === 'succeeded' &&
    typeof item.childSessionKey === 'string' &&
    item.childSessionKey.startsWith(`agent:${CHILD}:subagent:`));
  if (task.length !== 1 || !Number.isSafeInteger(task[0].createdAt) ||
      !Number.isSafeInteger(task[0].endedAt)) throw new Error('Correlated child completion is unavailable');
  const [parent, child] = await Promise.all([
    readMessages({ agentId: 'main', sessionKey: parentSessionKey }),
    readMessages({ agentId: CHILD, sessionKey: task[0].childSessionKey }),
  ]);
  const turn = latestExternalTurn(parent);
  if (turn === null || task[0].createdAt < turn || task[0].endedAt < task[0].createdAt) {
    throw new Error('Jessica completion belongs to an earlier request');
  }
  const { entry, result: authoritative } = matchingToolResult(child, runId);
  const last = child.at(-1);
  if (last?.role !== 'assistant' || last.seq <= entry.seq || last.message?.stopReason === 'toolUse') {
    throw new Error('Jessica final completion is missing');
  }
  const final = parsed(textOf(last.message, true));
  const derived = final.status === 'clarification_required' ?
    validateClarification(final, authoritative, child, now) :
    final.status === 'failure' && final.error?.code === 'CONTROL_NOT_ENABLED' ?
      validateDisabledControl(final, authoritative, child, now) : null;
  if (derived === null) {
    if (!isDeepStrictEqual(final, authoritative)) throw new Error('Child completion differs from Jessica tool truth');
    if (authoritative.operation === 'status' || authoritative.operation === 'rooms' ||
        authoritative.operation === 'capabilities' || authoritative.status !== 'success') {
      validateResult(authoritative, null, now);
    }
  }
  return structuredClone(derived ?? final);
}

// Staged S06 adapter: native run and transcript correlation supplies the result.
// Task identity, pending binding and candidate text arrive separately.
export async function normalizeJessicaCompletion(args, trusted, messageCandidate = null) {
  const result = await validateJessicaCompletion(args);
  return normalizeLegacyTaskResult(result, trusted, messageCandidate);
}

export function createNativeTranscriptReader({ getSessionEntry, readVisibleMessages }) {
  if (typeof getSessionEntry !== 'function' || typeof readVisibleMessages !== 'function') {
    throw new Error('Native transcript dependencies are required');
  }
  return async ({ agentId, sessionKey }) => {
    const sessionId = getSessionEntry({ agentId, sessionKey })?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error('Correlated transcript session is unavailable');
    }
    return readVisibleMessages({ agentId, sessionId });
  };
}

export function createJessicaCompletionToolFactory({ jsonResult, tasks, readMessages, logger,
  clock = () => new Date() }) {
  if (typeof jsonResult !== 'function' || !tasks?.runs?.fromToolContext ||
      typeof readMessages !== 'function') {
    throw new Error('Native Jessica completion dependencies are required');
  }
  return (toolContext) => {
    if (toolContext.agentId !== 'main') return null;
    return {
      name: 'jessica_validate_completion', label: 'Validate Jessica completion',
      description: 'After native child completion, compare its final JSON to the correlated deterministic Jessica tool result. Read-only.',
      parameters: PARAMETERS, executionMode: 'sequential',
      async execute(_toolCallId, args) {
        try {
          if (!args || Object.keys(args).length !== 1 || typeof args.runId !== 'string' ||
              !args.runId || args.runId.length > 160) throw new Error('Invalid native run id');
          const result = await validateJessicaCompletion({
            runId: args.runId, parentSessionKey: toolContext.sessionKey,
            runs: tasks.runs.fromToolContext(toolContext).list(), readMessages, now: clock(),
          });
          return jsonResult({ validated: true, result });
        } catch (error) {
          logger?.warn?.(`Jessica completion validation rejected: ${error instanceof Error ? error.message : 'unknown error'}`);
          return jsonResult({ validated: false, code: 'JESSICA_COMPLETION_UNVERIFIED' });
        }
      },
    };
  };
}
