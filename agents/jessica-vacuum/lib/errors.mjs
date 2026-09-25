export class DomainError extends Error {
  constructor(code, stage, message, details = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.stage = stage;
    this.details = details;
  }
}

export function deny(code, stage, message, details) {
  throw new DomainError(code, stage, message, details);
}
