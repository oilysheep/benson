# Reminder Service Workspace

Internal Benson Reminder domain workspace, aligned with OpenClaw
`2026.9.4` native Automations and native child completion.

- `AGENTS.md` — domain ownership, narrow-tool contracts, and structured native
  completion result.
- `tools/reminder-service` — the preserved deterministic executable boundary.
- `benson_reminder_create`, `benson_reminder_list`, `benson_reminder_find`,
  `benson_reminder_update`, `benson_reminder_pause`, `benson_reminder_resume`,
  and `benson_reminder_delete` — operation-specific OpenClaw contracts that
  invoke the same preserved executable without shell execution or a parallel
  implementation.
- `libexec/reminder-service-core` — the existing deterministic implementation,
  patched in place to use live OpenClaw Automations as the source of truth.
- `lib/reminder_discovery.py` — the existing discovery interface, reading the
  same live Automation state through the core.
- `config/recipients.json` — Pi-owned identity and routing configuration;
  installer preserves it unchanged and the package does not contain a copy.
- `state/links/` — optional minimal Automation↔Calendar link metadata only.
- `tests/` — isolated native-source, plugin-boundary, authorization,
  multi-recipient/recurrence, ambiguity, notification, and Calendar transaction
  regressions.

Immediate secondary-recipient lifecycle notifications reuse the same
`transport.deliveries` contract that create already used. Update, pause,
resume, and delete add verified pending delivery intents only after the native
Automation/Calendar transition succeeds. Main performs the native message send
with the supplied `idempotencyKey`; Reminder Service never sends interactive
messages and never rolls back verified Reminder state because notification
delivery failed.

There is no active `TOOLS.md`, Reminder skill package, complete Reminder
registry, scheduler, run-history copy, handoff store, finalizer, or outbound
dispatcher. OpenClaw owns scheduling, job state, run history, child correlation,
and scheduled delivery. Main remains the only interactive user-facing agent.

Calendar-linked one-shot reminders are supported transactionally with verified
create/get/delete and compensation. Recurring Calendar linkage and attendees
remain unsupported and fail before side effects.
