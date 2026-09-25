import { readFileSync } from 'node:fs';
import { DomainError } from '../../../../../agents/jessica-vacuum/lib/errors.mjs';

const ROSTER_URL = new URL('../../../../../agents/reminder-service/config/recipients.json', import.meta.url);

export function loadTrustedRoutes(path = ROSTER_URL) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (!config || typeof config.accountId !== 'string' || !config.accountId ||
      !Array.isArray(config.trustedRequesterIds) || !config.trustedRequesterIds.length ||
      !Array.isArray(config.recipients)) {
    throw new Error('Canonical family route roster is invalid');
  }
  const byId = new Map(config.recipients.map((person) => [person.id, person]));
  const byRoute = new Map();
  for (const id of config.trustedRequesterIds) {
    const person = byId.get(id);
    if (typeof id !== 'string' || !id || !person || person.type !== 'person' ||
        person.channel !== 'whatsapp' || typeof person.to !== 'string' || !person.to ||
        byRoute.has(person.to)) {
      throw new Error('Canonical family route roster has an invalid or duplicate approved person');
    }
    byRoute.set(person.to, id);
  }
  return Object.freeze({ accountId: config.accountId, byRoute, approvedIds: Object.freeze([...config.trustedRequesterIds]) });
}

export function assertRosterPolicyAgreement(roster, policy) {
  const expected = new Set(roster.approvedIds.flatMap((subject) => [
    `${subject}:read:jessica-vacuum`, `${subject}:control:jessica-vacuum`,
  ]));
  const actual = new Set(policy.rules.filter((rule) => rule.decision === 'allow').map((rule) =>
    `${rule.subject}:${rule.actionClass}:${rule.deviceScope}`));
  if (actual.size !== expected.size || [...actual].some((entry) => !expected.has(entry)) ||
      policy.rules.some((rule) => rule.decision !== 'allow')) {
    throw new Error('Jessica policy and canonical approved family roster disagree');
  }
}

export function resolveTrustedIdentity(toolContext, roster) {
  const route = toolContext?.deliveryContext;
  if (route?.channel !== 'whatsapp' || route.accountId !== roster.accountId ||
      typeof route.to !== 'string' || !route.to) {
    throw new DomainError('IDENTITY_UNTRUSTED', 'identity', 'Trusted requester route is unavailable');
  }
  const sender = typeof toolContext.requesterSenderId === 'string' ? toolContext.requesterSenderId.trim() : '';
  const group = route.to.endsWith('@g.us');
  if (group && !sender) {
    throw new DomainError('IDENTITY_UNTRUSTED', 'identity', 'Trusted per-sender group identity is unavailable');
  }
  if (!group && sender && sender !== route.to) {
    throw new DomainError('IDENTITY_UNTRUSTED', 'identity', 'Requester and private route disagree');
  }
  const subject = roster.byRoute.get(group ? sender : route.to);
  if (!subject) throw new DomainError('IDENTITY_UNTRUSTED', 'identity', 'Requester is not in the approved route roster');
  return Object.freeze({
    source: 'trusted_runtime', senderId: subject,
    channelKind: group ? 'group' : 'direct', perSenderVerified: group ? Boolean(sender) : true,
  });
}
