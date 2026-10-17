import Type, { type Static } from 'typebox';
import { decode, freeze, object } from '../../../integrations/openclaw/benson-routing/core/value.js';
import { Nonempty, SourceSchema } from './schemas.js';
export const RosterSchema = Type.Object({ accountId: Nonempty, trustedRequesterIds: Type.Array(Nonempty, { minItems: 1, uniqueItems: true }),
  recipients: Type.Array(Type.Object({ id: Nonempty, type: Type.Enum(['person', 'group']), channel: Nonempty, to: Nonempty }), { minItems: 1 }) });
export const RuntimeRouteSchema = object({ requesterId: Nonempty, sourceType: SourceSchema.properties.type, sourceId: Nonempty, senderId: Nonempty });
export type RuntimeRoute = Static<typeof RuntimeRouteSchema>;
export function loadIdentityContract(raw: unknown) {
  const roster = structuredClone(decode(RosterSchema, raw, 'reminder_roster_invalid'));
  const ids = roster.recipients.map(item => item.id.trim());
  if (new Set(ids).size !== ids.length || ids.some(id => !id)) throw new Error('Reminder recipient ids must be unique');
  const routes = new Map<string, string>();
  for (const id of roster.trustedRequesterIds) {
    const recipient = roster.recipients.find(item => item.id === id);
    if (id !== id.trim() || !recipient || recipient.type !== 'person' || recipient.channel !== 'whatsapp' || !recipient.to.trim() || routes.has(recipient.to.trim())) throw new Error('Reminder trusted requester route is invalid');
    routes.set(recipient.to.trim(), id);
  }
  const accountId = roster.accountId.trim();
  if (!accountId) throw new Error('Reminder account is invalid');
  return Object.freeze({ recipientIds: freeze(ids), trustedRequesterIds: freeze(roster.trustedRequesterIds), accountId,
    requesterForPrivateRoute: (route: string) => routes.get(route) ?? null });
}
export type IdentityContract = ReturnType<typeof loadIdentityContract>;
/** Input is an adapter-produced route DTO; native context parsing has a separate owner. */
export function resolveRoute(contract: IdentityContract, delivery: { channel: string; accountId: string; to: string; senderId: string }): RuntimeRoute | null {
  if (delivery.channel !== 'whatsapp' || delivery.accountId !== contract.accountId) return null;
  const sourceId = delivery.to.trim(), sender = delivery.senderId.trim(), group = sourceId.endsWith('@g.us');
  const requesterId = contract.requesterForPrivateRoute(group ? sender : sourceId);
  if (!requesterId || !group && sender && sender !== sourceId) return null;
  return { requesterId, sourceType: group ? 'group' : 'private', sourceId, senderId: sender || sourceId };
}
