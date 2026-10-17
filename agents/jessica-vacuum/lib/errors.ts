import { type JsonObject } from '../../../integrations/openclaw/benson-routing/core/value.js';

export type FailureStage = 'input' | 'identity' | 'authorization' | 'resolution' | 'precondition' | 'dispatch' | 'verification' | 'integrity';
export class DomainError extends Error {
  override readonly name = 'DomainError';
  constructor(readonly code: string, readonly stage: FailureStage, message: string,
    readonly details: JsonObject = {}) { super(message); }
}
export function deny(code: string, stage: FailureStage, message: string, details?: JsonObject): never {
  throw new DomainError(code, stage, message, details);
}
