import { parseAgentSessionKey } from 'openclaw/plugin-sdk/routing';
import { resolveRoute, type IdentityContract } from '../../../../../agents/reminder-service/lib/identity.js';
import { createMainRequestAdmissionController } from '../../core/request-control.js';
import { fail, plain } from '../../core/value.js';

/** The existing WhatsApp bridge supplies native contexts, never model arguments.
 * Entry admission retires with execution; delivery independently rechecks the
 * retained source and canonical identity through assertSourceCurrent. */
export function createNativeMainRequestAdmission(identities: IdentityContract, original: unknown, nativeCurrent: () => void) {
  if (!plain(original)) fail('native_request_context_invalid');
  const fields = ['Provider', 'Surface', 'AccountId', 'SenderId', 'From', 'To', 'MessageSid', 'SessionKey', 'RawBody'];
  const captured = Object.freeze(Object.fromEntries(fields.map(name => [name, original[name]])));
  const text = (name: string) => {
    const value = captured[name];
    if (typeof value !== 'string' || !value.trim()) fail('native_request_context_invalid');
    return value;
  };
  const authorize = () => {
    if (text('Provider') !== 'whatsapp' || text('Surface') !== 'whatsapp' || text('AccountId') !== identities.accountId)
      fail('native_request_route_invalid');
    const route = resolveRoute(identities, { channel: 'whatsapp', accountId: identities.accountId,
      to: text('From'), senderId: text('SenderId') });
    if (!route) fail('native_request_requester_untrusted');
    // Parse only the actual native session; never default an invalid key to Main
    // or replace OpenClaw's selected route with a second routing implementation.
    if (parseAgentSessionKey(text('SessionKey'))?.agentId !== 'main') fail('native_request_non_main_route');
    return route;
  };
  const route = Object.freeze(authorize()), requestId = text('MessageSid'), sessionKey = text('SessionKey');
  let finalContext: Record<string, unknown> | undefined;
  const assertSourceCurrent = () => {
    nativeCurrent();
    if (!finalContext) fail('native_request_handoff_unavailable');
    for (const name of fields) if (original[name] !== captured[name] || finalContext[name] !== captured[name])
      fail('native_request_source_changed');
    const current = authorize();
    if (current.requesterId !== route.requesterId || current.sourceId !== route.sourceId ||
        current.sourceType !== route.sourceType || current.senderId !== route.senderId) fail('native_request_identity_changed');
  };
  const controller = createMainRequestAdmissionController({ assertCurrent: assertSourceCurrent,
    authorize: () => ({ requesterId: authorize().requesterId, targetAgentId: 'main' }) });
  let admission: ReturnType<typeof controller.admit> | undefined;
  return Object.freeze({
    requestId, sessionKey, route, request: text('RawBody'),
    admit(context: unknown) {
      if (finalContext || !plain(context)) fail('native_request_handoff_invalid');
      finalContext = context;
      admission = controller.admit({ schemaVersion: 1, kind: 'candidate', reason: null,
        requestId, sessionKey, request: text('RawBody') });
      return admission;
    },
    assertCurrent() { controller.assertCurrent(admission); },
    assertSourceCurrent,
    retire() { controller.retire(); },
  });
}
