import { deny } from './errors.mjs';
import { deepFreeze } from './immutable.mjs';

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function loadPolicy(input) {
  if (!record(input) || Object.keys(input).sort().join(',') !== 'defaultDecision,rules,version' ||
      input.version !== '1' || input.defaultDecision !== 'deny' || !Array.isArray(input.rules)) {
    deny('INVALID_POLICY', 'authorization', 'Policy must be versioned and default-deny');
  }
  const keys = new Set();
  for (const rule of input.rules) {
    if (!record(rule) || Object.keys(rule).sort().join(',') !== 'actionClass,decision,deviceScope,subject' ||
        typeof rule.subject !== 'string' || !rule.subject || rule.subject === '*' ||
        !['read', 'control'].includes(rule.actionClass) || rule.deviceScope !== 'jessica-vacuum' ||
        !['allow', 'deny'].includes(rule.decision)) {
      deny('INVALID_POLICY', 'authorization', 'Policy rule is invalid');
    }
    const key = `${rule.subject}\0${rule.actionClass}\0${rule.deviceScope}`;
    if (keys.has(key)) deny('INVALID_POLICY', 'authorization', 'Policy has duplicate rules');
    keys.add(key);
  }
  return deepFreeze(structuredClone(input));
}

// trustedIdentity must be constructed by the native adapter from runtime context,
// never copied from tool arguments or the child agent brief.
export function authorize(policy, trustedIdentity, actionClass) {
  if (!record(trustedIdentity) || trustedIdentity.source !== 'trusted_runtime' ||
      typeof trustedIdentity.senderId !== 'string' || !trustedIdentity.senderId ||
      !['direct', 'group'].includes(trustedIdentity.channelKind) ||
      (trustedIdentity.channelKind === 'group' && trustedIdentity.perSenderVerified !== true)) {
    deny('IDENTITY_UNTRUSTED', 'identity', 'Trusted per-sender identity is unavailable');
  }
  if (!['read', 'control'].includes(actionClass)) deny('INVALID_ACTION_CLASS', 'authorization', 'Unknown action class');
  const rule = policy.rules.find((item) => item.subject === trustedIdentity.senderId &&
    item.actionClass === actionClass && item.deviceScope === 'jessica-vacuum');
  if (!rule || rule.decision !== 'allow') {
    deny('NOT_AUTHORIZED', 'authorization', 'Requester is not approved');
  }
  return { policyVersion: policy.version, subject: trustedIdentity.senderId, actionClass };
}
