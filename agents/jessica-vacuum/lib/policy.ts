import { decode, freeze } from '../../../integrations/openclaw/benson-routing/core/value.js';
import { PolicySchema, IdentitySchema, type Policy } from './schemas.js';
import { deny } from './errors.js';

export function loadPolicy(input: unknown): Policy {
  let policy: Policy;
  try { policy = decode(PolicySchema, input, 'policy_invalid'); }
  catch { return deny('INVALID_POLICY', 'authorization', 'Policy must be versioned and default-deny'); }
  const keys = new Set<string>();
  for (const rule of policy.rules) {
    if (rule.subject === '*') deny('INVALID_POLICY', 'authorization', 'Policy rule is invalid');
    const key = `${rule.subject}\0${rule.actionClass}\0${rule.deviceScope}`;
    if (keys.has(key)) deny('INVALID_POLICY', 'authorization', 'Policy has duplicate rules'); keys.add(key);
  }
  return freeze(structuredClone(policy));
}
/** The native adapter constructs identity; input/quoted text never grants it. */
export function authorize(policy: Policy, input: unknown, actionClass: 'read' | 'control') {
  let identity;
  try { identity = decode(IdentitySchema, input, 'identity_invalid'); }
  catch { return deny('IDENTITY_UNTRUSTED', 'identity', 'Trusted per-sender identity is unavailable'); }
  if (identity.channelKind === 'group' && identity.perSenderVerified !== true) {
    deny('IDENTITY_UNTRUSTED', 'identity', 'Trusted per-sender identity is unavailable');
  }
  if (actionClass !== 'read' && actionClass !== 'control') deny('INVALID_ACTION_CLASS', 'authorization', 'Unknown action class');
  if (!policy.rules.some(rule => rule.subject === identity.senderId && rule.actionClass === actionClass && rule.decision === 'allow')) {
    deny('NOT_AUTHORIZED', 'authorization', 'Requester is not approved');
  }
  return { policyVersion: policy.version, subject: identity.senderId, actionClass };
}
