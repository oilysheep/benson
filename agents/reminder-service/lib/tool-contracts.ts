import Type from 'typebox';
import { object, freeze } from '../../../integrations/openclaw/benson-routing/core/value.js';
import { PublicSchemas, CreateInputSchema, PlanItemSchema, ProvenanceSchema, UpdateInputSchema, type ToolName } from './schemas.js';
import type { IdentityContract, RuntimeRoute } from './identity.js';
/** Project canonical roster restrictions into the same domain-owned schemas. */
export function schemaForTool(name: ToolName, identities: IdentityContract, route?: RuntimeRoute) {
  const requester = Type.Enum(route ? [route.requesterId] : [...identities.trustedRequesterIds]);
  const recipient = Type.Enum([...identities.recipientIds]);
  const source = route ? object({ type: Type.Literal(route.sourceType), id: Type.Literal(route.sourceId) }) : CreateInputSchema.properties.sourceConversation;
  const provenance = object({ ...ProvenanceSchema.properties, requesterId: Type.Enum([...identities.trustedRequesterIds]) });
  const createFields = { requesterId: requester, recipientIds: Type.Array(recipient, { minItems: 1 }), sourceConversation: source };
  switch (name) {
    case 'benson_reminder_create': return freeze(object({ input: object({ ...CreateInputSchema.properties, ...createFields, provenance: Type.Optional(provenance) }) }));
    case 'benson_reminder_create_plan': return freeze(object({ input: object({ items: Type.Array(object({ ...PlanItemSchema.properties, ...createFields,
      provenance: object({ ...provenance.properties, fieldEvidence: PlanItemSchema.properties.provenance.properties.fieldEvidence }) }), { minItems: 2, maxItems: 2 }) }) }));
    case 'benson_reminder_update': return freeze(object({ ...PublicSchemas.benson_reminder_update.properties, requesterId: requester,
      input: Type.Object({ ...UpdateInputSchema.properties, recipientId: Type.Optional(recipient) }, { additionalProperties: false, minProperties: 1 }) }));
    case 'benson_reminder_list': return freeze(object({ ...PublicSchemas.benson_reminder_list.properties, requesterId: requester, recipient: Type.Optional(recipient) }));
    case 'benson_reminder_find': return freeze(object({ ...PublicSchemas.benson_reminder_find.properties, requesterId: requester, recipient: Type.Optional(recipient) }));
    case 'benson_reminder_pause': case 'benson_reminder_resume': case 'benson_reminder_delete': return freeze(object({ ...PublicSchemas[name].properties, requesterId: requester }));
  }
}
