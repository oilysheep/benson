import { deny } from './errors.js';
import type { Policy, TrustedIdentity } from './schemas.js';
export interface FamilyRoutes { readonly accountId: string; readonly approvedIds: readonly string[]; subjectForRoute(route: string): string | null }
export function assertRosterPolicyAgreement(roster: FamilyRoutes, policy: Policy): void {
  const expected = new Set(roster.approvedIds.flatMap(subject => [`${subject}:read:jessica-vacuum`, `${subject}:control:jessica-vacuum`]));
  const actual = new Set(policy.rules.filter(rule => rule.decision === 'allow').map(rule => `${rule.subject}:${rule.actionClass}:${rule.deviceScope}`));
  if (actual.size !== expected.size || [...actual].some(entry => !expected.has(entry)) || policy.rules.some(rule => rule.decision !== 'allow')) throw new Error('Jessica policy and canonical family roster disagree');
}
export function resolveTrustedIdentity(route: { channel: string; accountId: string; to: string; senderId: string }, roster: FamilyRoutes): TrustedIdentity {
  if (route.channel !== 'whatsapp' || route.accountId !== roster.accountId || !route.to) return deny('IDENTITY_UNTRUSTED', 'identity', 'Trusted requester route is unavailable');
  const sender = route.senderId.trim(), group = route.to.endsWith('@g.us');
  if (group && !sender || !group && sender && sender !== route.to) return deny('IDENTITY_UNTRUSTED', 'identity', 'Requester and route disagree');
  const subject = roster.subjectForRoute(group ? sender : route.to);
  if (!subject) return deny('IDENTITY_UNTRUSTED', 'identity', 'Requester is not in the approved roster');
  return Object.freeze({ source: 'trusted_runtime', senderId: subject, channelKind: group ? 'group' : 'direct', perSenderVerified: true });
}
