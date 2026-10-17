import type { CreateInput, PlanItem, Calendar, Provenance } from './schemas.js';
import type { RuntimeRoute } from './identity.js';
export interface OriginalUserTurn { readonly text: string }
export interface ReminderEvidence {
  readCurrentUserText(): Promise<string>;
  readOriginalUserTurns(): Promise<readonly OriginalUserTurn[]>;
}
type Citation = Provenance['fieldEvidence'][number];
type Verified = { evidence: ReadonlyMap<string, string>; citations: ReadonlyMap<string, Citation> };
export function requiredProvenanceFields(input: CreateInput | PlanItem): string[] {
  const fields = ['content', 'calendar.requested'];
  if (input.recipientIds.some(id => id !== input.requesterId)) fields.push('recipientIds');
  if ('schedules' in input && input.schedules) fields.push(...input.schedules.map((_, i) => `schedules[${i}]`)); else fields.push('schedule');
  if (input.calendar.requested) {
    fields.push('calendar.durationMinutes');
    if (input.calendar.eventSchedule) fields.push('calendar.eventSchedule');
    for (const field of ['summary', 'description', 'location']) if (Object.hasOwn(input.calendar, field)) fields.push(`calendar.${field}`);
  }
  return fields;
}
export async function validateProvenance(input: CreateInput | PlanItem, evidenceReader: ReminderEvidence, route: RuntimeRoute, now: Date): Promise<Verified | null> {
  const value = input.provenance;
  const calendar: Calendar = input.calendar;
  const requiresBundle = 'schedules' in input && input.schedules !== undefined ||
    (['summary', 'description', 'location'] as const).some(field => calendar[field]?.evidenceId !== undefined);
  if (!value) {
    if (requiresBundle) throw new Error('Reminder provenance is required');
    return null;
  }
  if (value.requesterId !== input.requesterId || value.requesterId !== route.requesterId || value.sourceConversation.type !== input.sourceConversation.type ||
    value.sourceConversation.id !== input.sourceConversation.id || value.sourceConversation.type !== route.sourceType || value.sourceConversation.id !== route.sourceId) throw new Error('Reminder provenance route mismatch');
  const created = Date.parse(value.createdAt), expires = Date.parse(value.expiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expires) || created >= expires || expires < now.getTime() || created > now.getTime() + 300_000) throw new Error('Reminder provenance time invalid');
  const evidence = new Map<string, string>();
  for (const item of value.evidence) { if (evidence.has(item.id)) throw new Error('Duplicate Reminder evidence id'); evidence.set(item.id, item.text); }
  if (value.revision !== value.evidence.length || value.evidence.at(-1)?.id !== value.currentEvidenceId || !evidence.has(value.currentEvidenceId)) throw new Error('Reminder provenance revision invalid');
  const current = await evidenceReader.readCurrentUserText();
  if ([...evidence.values()].some(text => !current.includes(text))) throw new Error('Reminder evidence not grounded in current task');
  const turns = await evidenceReader.readOriginalUserTurns();
  if (!turns.length) throw new Error('Original Reminder user turns unavailable');
  let exclusive = turns.length, latest = -1;
  for (let i = value.evidence.length - 1; i >= 0; i--) {
    const item = value.evidence[i];
    if (!item) throw new Error('Reminder evidence sequence invalid');
    let match = -1;
    for (let j = exclusive - 1; j >= 0; j--) if (turns[j]?.text.includes(item.text)) { match = j; break; }
    if (match < 0) throw new Error('Reminder evidence not grounded in original turns');
    if (i === value.evidence.length - 1) latest = match;
    exclusive = match;
  }
  if (latest !== turns.length - 1) throw new Error('Reminder evidence does not end at latest user turn');
  const citations = new Map<string, Citation>();
  for (const citation of value.fieldEvidence) {
    if (citations.has(citation.field) || !evidence.get(citation.evidenceId)?.includes(citation.quote)) throw new Error('Reminder citation invalid');
    citations.set(citation.field, citation);
  }
  if (requiredProvenanceFields(input).some(field => !citations.has(field))) throw new Error('Reminder field evidence missing');
  return { evidence, citations };
}
export async function validateCalendarMetadata(calendar: Calendar, verbatim: string | undefined, verified: Verified | null, reader: ReminderEvidence): Promise<void> {
  const fields = (['summary', 'description', 'location'] as const).filter(field => calendar[field] !== undefined);
  if (!fields.length) return;
  for (const field of fields) {
    const metadata = calendar[field];
    if (!metadata) throw new Error('Reminder metadata missing');
    if (verified) {
      const citation = verified.citations.get(`calendar.${field}`);
      if (!metadata.evidenceId || metadata.evidenceId !== citation?.evidenceId || metadata.evidenceQuote.trim() !== citation.quote || !metadata.evidenceQuote.includes(metadata.value.trim())) throw new Error('Reminder metadata citation mismatch');
    } else if (!verbatim?.trim() || !verbatim.trim().includes(metadata.evidenceQuote.trim()) || !metadata.evidenceQuote.trim().includes(metadata.value.trim())) throw new Error('Reminder metadata not grounded');
  }
  if (!verified && !(await reader.readCurrentUserText()).includes(verbatim?.trim() ?? '')) throw new Error('Reminder verbatim request not grounded in current task');
}
