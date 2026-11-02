import { isDeepStrictEqual as same } from 'node:util';
import { assertion, assertArrayData, boundedCopy, fail, freeze, identifier, plain } from './value.js';

/** Provider-neutral host evidence. No patched SDK types or domain state ownership. */
export interface ToolExecutionReceipt {
  readonly ordinal: number; readonly attempt: number; readonly callId: string; readonly name: string;
  readonly originalArgs: unknown; readonly validatedArgs?: unknown; readonly executionArgs?: unknown;
  readonly executionStarted: boolean; readonly originalIsError: boolean; readonly originalResult: unknown; readonly isError: boolean; readonly result: unknown;
}
export interface ToolExecutionCoverage {
  readonly version: 1;
  readonly identity: { readonly runId: string; readonly sessionKey: string; readonly sessionId: string; readonly agentId: string };
  readonly receipts: readonly ToolExecutionReceipt[];
  readonly seal: { readonly complete: boolean; readonly count: number; readonly attempts: number };
}
declare const evidenceBrand: unique symbol;
export interface ToolExecutionEvidence { readonly [evidenceBrand]: true }
export interface ToolExecutionEvidenceProvider {
  waitForSettlement(runId: string, signal: AbortSignal): Promise<void>;
  evidence(runId: string): ToolExecutionEvidence;
}
const sources = new WeakMap<object, () => ToolExecutionCoverage>();
/** Trusted provider boundary only. A report/serialized record cannot mint custody. */
export function retainToolExecutionEvidence(read: () => ToolExecutionCoverage, assertCurrent: () => unknown): ToolExecutionEvidence {
  const handle = Object.freeze({});
  sources.set(handle, () => { assertion(assertCurrent(), 'tool_evidence_custody'); return read(); });
  return handle as ToolExecutionEvidence;
}
export function readToolExecutionEvidence(evidence: unknown, identity: ToolExecutionCoverage['identity']): Readonly<ToolExecutionCoverage> {
  const source = evidence !== null && typeof evidence === 'object' ? sources.get(evidence) : undefined;
  if (!source) fail('tool_execution_evidence_missing');
  const value = source();
  if (value.version !== 1 || !same(boundedCopy(value.identity), boundedCopy(identity)) || !value.seal.complete ||
      !Number.isSafeInteger(value.seal.attempts) || value.seal.attempts < 1 ||
      value.receipts.length > 64 || value.seal.count !== value.receipts.length) fail('tool_execution_coverage_unverified');
  const ids = new Set<string>();
  for (const [ordinal, receipt] of value.receipts.entries()) {
    if (receipt.ordinal !== ordinal || !Number.isSafeInteger(receipt.attempt) || receipt.attempt < 1 || receipt.attempt > value.seal.attempts ||
        !identifier(receipt.callId) || !identifier(receipt.name) || typeof receipt.executionStarted !== 'boolean' ||
        typeof receipt.originalIsError !== 'boolean' || typeof receipt.isError !== 'boolean') fail('tool_execution_receipt_invalid');
    const key = JSON.stringify([receipt.attempt, receipt.callId]);
    if (ids.has(key)) fail('tool_execution_receipt_duplicate'); ids.add(key);
    boundedCopy(receipt.originalArgs); copyNativeToolResult(receipt.originalResult); copyNativeToolResult(receipt.result);
    if (Object.hasOwn(receipt, 'validatedArgs')) boundedCopy(receipt.validatedArgs);
    if (Object.hasOwn(receipt, 'executionArgs')) boundedCopy(receipt.executionArgs);
    if (receipt.executionStarted && (!Object.hasOwn(receipt, 'validatedArgs') || !Object.hasOwn(receipt, 'executionArgs'))) fail('tool_execution_arguments_missing');
  }
  return freeze({ ...value, identity: { ...value.identity }, seal: { ...value.seal },
    receipts: value.receipts.map(receipt => ({ ...receipt, originalArgs: boundedCopy(receipt.originalArgs),
      ...Object.hasOwn(receipt, 'validatedArgs') ? { validatedArgs: boundedCopy(receipt.validatedArgs) } : {},
      ...Object.hasOwn(receipt, 'executionArgs') ? { executionArgs: boundedCopy(receipt.executionArgs) } : {}, originalResult: copyNativeToolResult(receipt.originalResult), result: copyNativeToolResult(receipt.result) })) });
}
export function receiptDomainValue(receipt: ToolExecutionReceipt): unknown {
  if (!plain(receipt.originalResult) || !Object.hasOwn(receipt.originalResult, 'details')) fail('tool_execution_domain_result_missing');
  return boundedCopy(receipt.originalResult.details);
}

/** Native text carriers have their own byte budget; domain details retain domain limits. */
export function copyNativeToolResult(value: unknown): unknown {
  if (!plain(value) || !Array.isArray(value.content)) fail('tool_execution_result_invalid');
  assertArrayData(value.content);
  if (value.content.length > 256) fail('tool_execution_result_limit');
  const content = value.content.map(part => {
    if (!plain(part)) fail('tool_execution_result_invalid');
    const fields: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(part)) {
      const field = Object.getOwnPropertyDescriptor(part, key);
      if (typeof key !== 'string' || !field || !Object.hasOwn(field, 'value')) fail('tool_execution_result_invalid');
      fields[key] = typeof field.value === 'string' ? field.value : boundedCopy(field.value);
    }
    return fields;
  });
  const result = { content, ...Object.hasOwn(value, 'details') ? { details: boundedCopy(value.details) } : {} };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 1048576) fail('tool_execution_result_limit');
  return freeze(result);
}
export function copyToolExecutionReceipt(value: unknown): ToolExecutionReceipt {
  if (!plain(value)) fail('tool_execution_receipt_invalid');
  const { result, originalResult, ...rest } = value;
  return { ...boundedCopy(rest) as object, originalResult: copyNativeToolResult(originalResult), result: copyNativeToolResult(result) } as ToolExecutionReceipt;
}
