import { readFileSync } from 'node:fs';
import { loadIdentityContract, resolveRoute, type IdentityContract } from '../../../../../agents/reminder-service/lib/identity.js';
import type { OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
/** Configuration I/O stays in the integration; it introduces no second roster. */
export function loadCanonicalIdentityContract() {
  const raw: unknown = JSON.parse(readFileSync(new URL('../../../../../agents/reminder-service/config/recipients.json', import.meta.url), 'utf8'));
  return loadIdentityContract(raw);
}
/** Parse host context only; tool parameters never supply route or requester. */
export function resolveReminderRuntimeRoute(context: OpenClawPluginToolContext<2>, identities: IdentityContract) {
  const route = context.deliveryContext;
  if (typeof route?.channel !== 'string' || typeof route.accountId !== 'string' || typeof route.to !== 'string') return null;
  return resolveRoute(identities, { channel: route.channel, accountId: route.accountId, to: route.to,
    senderId: typeof context.requesterSenderId === 'string' ? context.requesterSenderId : '' });
}
