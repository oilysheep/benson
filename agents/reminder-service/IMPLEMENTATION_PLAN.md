# Benson Reminder Recovery — Original Implementation Plan

This is the durable English rendering of the original Reminder recovery plan
presented in this engineering session on 2026-09-13 at 10:42:20 UTC. The
source response has SHA-256
`f61d0ad0f24f029dca44ca49d9903773a1c5e9999c76938011e133cec80f2cab`.
Its ten-section structure, thirteen-stage order, objectives, decisions, and
acceptance intent are preserved below. Statements of current state and proposed
mechanisms are historical as of that date. Subsequent operator decisions and
verified implementation may supersede a proposal here. This document is a
roadmap and history, not a runtime contract or a command to repeat completed
work. Current architecture, behavior, policy, schemas, and state belong to
`architecture/BENSON_SUBAGENT_ARCHITECTURE.md`, the applicable `AGENTS.md`
files, canonical code/configuration/tests, and focused live inspection.

**Post-plan execution status (2026-09-20; not part of the original proposal):**

- **Original planned work:** The ten sections and thirteen stages below retain
  their original objectives and historical planning language.
- **Completed work:** Stage 12 **PASS** and Stage 13 **PASS**. No Reminder
  implementation work is currently open. The Reminder model remains Sol
  (`openai/gpt-5.6-sol`). The operator-verified accepted baseline is
  `/home/oa/projects/benson/output/context/benson-context-20260920-100523.md`.
- **Deferred/future work:** Per-user Calendar authorization/routing and a
  possible Sol-to-Terra evaluation are separate future decisions, not open
  work in the completed recovery stages. Neither is implemented here.

## 1. Objective

At the end of recovery, `reminder-service` must:

- Run from the canonical workspace `/home/oa/projects/benson/agents/reminder-service`.
- Receive requests only through Main and return the common structured result envelope.
- Expose only `benson_reminder_service` and the minimum required native capability to the Reminder LLM, as originally proposed.
- Perform mutation, authorization, Automations, Calendar work, rollback, and verification deterministically.
- Preserve supported create/list/find/update/delete/pause/resume, recurrence, recipients, groups, notifications, and Calendar linkage.
- Return all valid Reminders to canonical discovery without creating duplicate jobs.
- Use only OpenClaw Automations as the scheduler.
- Run with `skills: []`, without Skill Workshop, `exec`/`process`, or an unapproved model fallback, as originally proposed.
- Claim success only after deterministic verification.

No files or Reminder state-changing operations were changed in the original planning phase.

## 2. Verified current state

### Engineering environment

- Root `AGENTS.md` governed the repository, and `PLANS.md` governed the work.
- `architecture/BENSON_SUBAGENT_ARCHITECTURE.md` existed and was readable.
- The required canonical paths existed: contract, recipient configuration, wrapper, core, discovery, tests, state, and OpenClaw plugin.
- `/home/oa/projects/benson` was not a Git repository; Git checkpoints and rollback were unavailable.
- The active OpenClaw version was `2026.9.4 (3a9d69d)`.

### Agent and configuration

The inspected `~/.openclaw/openclaw.json` showed:

- `reminder-service.workspace` pointed to the canonical path.
- The model was the bare string `openai/gpt-5.6-sol`.
- `skills: []` and `profile: "minimal"`.
- `alsoAllow` contained `benson_reminder_service`, `calendar_event_create`, `calendar_event_get`, and `calendar_event_delete`.
- `message` and `exec` were denied.
- An `exec` configuration block still specified `host`, `mode`, and `safeBins`, although `exec` was denied.
- `process` was not configured, with no reason to add it.
- Global subagent policy denied the three Calendar tools.

A read-only attempt to inspect `tools.effective` was blocked by sandbox `EPERM`.
Whether Calendar tools were hidden from the isolated Reminder child but available
to deterministic Calendar execution was therefore **UNKNOWN**. The Calendar
entries could not be removed on assumption alone.

### Reminder tool

- The `benson-reminder-tool` plugin was registered, enabled, and loaded.
- A Gateway call to `benson_reminder_service` with `list-reminders` returned `internal_error`.
- The canonical `agents/reminder-service/tools/reminder-service` executable succeeded on the same list operation and returned three verified Reminders.
- The failure came from `integrations/openclaw/plugins/benson-reminder-tool/dist/runner.js`, whose default lookup used `~/.openclaw/workspaces/reminder-service/...`.
- That retired path did not exist, and `agents/reminder-service/AGENTS.md` still documented it.

### Automations and background work

The live inventory contained:

- Three active one-shot jobs with `benson.reminder-service.v4` metadata, owned by `reminder-service`, with command payloads and WhatsApp delivery.
- An active recurring job named `daily-vitamin-reminder-17-00` with a zero-LLM command payload and successful latest delivery, but without `v4` metadata or `agentId`. It was absent from canonical Reminder listing.
- An enabled Skill Workshop job with declaration key `skill-collection-review:reminder-service`, running `agentTurn` with `write`, `edit`, `apply_patch`, `exec`, and `process` permissions.
- A disabled legacy one-shot job owned by Main, using `agentTurn` and Luna, without `accountId`, and with historical timeouts.
- No OpenClaw tasks in `running` state and no active Reminder heartbeat.
- No active sender-policy warnings in current job records. An earlier run of the recurring vitamin job failed delivery without an explicit agent owner; its latest run succeeded, making this a migration risk rather than proof of a current failure.

### Calendar

- The core implemented Calendar create/get/delete, verification, link persistence, replacement update, rollback, and duplicate prevention.
- `tangleclaw-google-oauth` version `0.3.5` was installed but disabled; the plugin registry reported `provenance-invalid`.
- `state/links` was empty, and none of the three current canonical Reminders was Calendar-linked.
- Consequently, Calendar-linked Reminder lifecycle was not available in practice at that time.

### Durable implementation

- `agents/reminder-service/libexec/reminder-service-core` used OpenClaw Automations as the state source and `benson.reminder-service.v4` as managed metadata.
- There was no parallel registry; local state was only for Automation-to-Calendar links.
- Recipient aliases, routes, people, and groups were defined in `agents/reminder-service/config/recipients.json`.
- That configuration had no explicit authorization matrix.
- The code resolved `requesterId` and recipient identities but did not enforce whether the requester was authorized to view or change the requested Reminder.
- `agents/reminder-service/lib/reminder_discovery.py` returned all relevant `v4` matches but had no requester authorization context.
- Three old `output/dispatch-bundles` were not consumed by the active implementation.
- An old Reminder Skill Workshop proposal referred to paths and behavior predating the then-current core.

## 3. Snapshot-derived state

The latest valid snapshot was
`output/context/benson-context-20260913-103104.md`, created on 2026-09-13 at
10:31:04 IDT. It recorded the same OpenClaw version, the recurring vitamin
job, the three `v4` jobs, the Skill Workshop job, and the old Skill Workshop
proposal. Each operational fact was checked again in live inspection, so no
material Reminder fact remained snapshot-only. The live inventory of ten total
jobs superseded the snapshot's older count.

## 4. Intended architectural state

Under the canonical architecture:

- Main is the sole interactive orchestrator.
- Main identifies the domain, collects trusted runtime context, resolves conversational references, calls `sessions_spawn` with `context: "isolated"`, waits via `sessions_yield`, validates the result envelope, and formulates the response.
- Main does not choose a Reminder ID, calculate a schedule patch, or mutate Calendar or Automations.
- Reminder classifies the operation, interprets schedule semantics, performs matching and clarification, and selects the deterministic operation.
- Deterministic tooling owns authorization, state mutation, Calendar/Automation mechanics, rollback, idempotency, and verification.
- OpenClaw Automations is the only scheduler, durable job store, and delivery substrate.
- Simple scheduled delivery uses a command payload without an LLM at fire time.
- A dedicated domain agent starts with zero runtime skills.
- The Reminder LLM must not have direct Calendar authority.
- Persistent behavior must not depend on hidden session state.
- A mutation may be retried only after durable state is inspected.

The inspected `main/AGENTS.md` contract matched these principles. There was no
reason to move Reminder logic into Main.

## 5. Capability inventory

| Capability | Evidence | Historical status | Decision | Notes / risks |
|---|---|---|---|---|
| One-shot create | Core, tests, live `v4` jobs | Present | **KEEP** | Core worked; runtime plugin path was broken. |
| Recurring create | Core, live vitamin job, partial tests | Present | **KEEP** | Calendar linkage was unsupported for recurring jobs. |
| Relative schedules | Core runtime-owned clock | Present | **KEEP** | User-supplied base time was rejected. |
| Local time, timezone, future resolution | Core and agent contract | Present | **KEEP** | Agent interpreted language; core required a timezone-aware future time. |
| List/find | Discovery and direct live list | Partial | **REPAIR** | Vitamin job was undiscoverable; authorization filtering was absent. |
| Content-only update | Core and tests | Present | **KEEP** | Linked Calendar summary was replaced when necessary. |
| Schedule-only update | Core and tests | Present | **KEEP** | Included one-shot, relative, and recurrence transitions. |
| Recurrence update | Core | Present | **KEEP** | Needed explicit test coverage. |
| Multi-field update | Core/plugin patch | Present | **KEEP** | Content, schedule, and Calendar could change together. |
| Recipient/scope update | No contract or core support | Unsupported | **KEEP fail-closed** | No canonical evidence justified extending it during recovery. |
| Unsupported update-field rejection | Plugin filtered fields | Weak | **REPAIR** | Unknown fields needed explicit rejection, not silent removal. |
| Delete/pause/resume | Core and tests | Present | **KEEP** | Needed authorization enforcement. |
| Clarification and continuation | Reminder/Main `AGENTS.md` | Defined | **KEEP / EXTEND tests** | Explicit `pendingContext`; no hidden-state dependency. |
| Self and authorized-other recipient | Core/configuration | Mechanically present | **REPAIR** | Authorization policy was missing. |
| Aliases and deterministic resolution | Configuration/core/tests | Present | **KEEP** | Unknown or ambiguous aliases failed closed. |
| Multiple recipients | Core | Present | **KEEP** | One job per recipient; authorization needed to be atomic. |
| Family/group/WhatsApp routing | Configuration/core | Present | **KEEP** | Requester identity had to remain separate from route identity. |
| Immediate secondary notification | Core/Main contract | Present | **KEEP** | Reminder state persisted even when notification failed. |
| Complete multi-match result | Discovery | `v4` only | **REPAIR** | Needed to include the vitamin job after migration. |
| Deterministic unique selection | Agent contract | Defined | **KEEP / EXTEND tests** | Arbitrary ID selection was prohibited. |
| Multi-Reminder mutation | No batch transaction contract | Unsupported | **KEEP fail-closed** | “Move both”/“delete those two” needed clarification or an unsupported result, not partial sequential mutation. |
| Calendar-linked create | Core/tests | Implemented; runtime broken | **REPAIR** | Existing Calendar plugin was disabled. |
| Calendar-linked update/delete | Core/tests | Implemented; runtime broken | **REPAIR** | Event replacement, verification, and rollback existed. |
| Calendar pause/resume | Core/tests | Present | **KEEP** | Event remained; only delivery job was paused. |
| Scheduled delivery | Automations command payload | Present | **KEEP / REPAIR ownership** | Zero LLM; vitamin needed canonical ownership/metadata. |
| Idempotency and duplicate prevention | Core/tests | Present | **KEEP** | Inspect state before mutation retry. |
| Legacy recovery/reconciliation | Historical artifacts and live vitamin job | Partial | **REPAIR** | Migrate in place, with no second scheduler or registry. |
| Main → Reminder boundary | Main/Reminder contracts | Conformant | **KEEP** | Needed E2E validation only. |

## 6. Implementation drift

| Historical current behavior/configuration | Intended behavior | Evidence | Why it mattered |
|---|---|---|---|
| Plugin runner used a retired workspace path | Canonical executable in the repository workspace | Live tool failure versus direct executable success | **IMPLEMENTATION DRIFT:** Reminder's sole tool did not work. |
| Reminder `AGENTS.md` documented the old path | Contract pointed at the canonical path | Reminder `AGENTS.md` | Could anchor a wrong future repair. |
| Test sought `payload/main` or `~/.openclaw/workspace/main` | Test read `/home/oa/projects/benson/main/AGENTS.md` | `test-v3-contract.sh` | Canonical checkout could fail or test an old contract. |
| No explicit recipient authorization | Deterministic core enforced least privilege | Configuration/core inspection | **IMPLEMENTATION DRIFT:** A requester could potentially view/change an unauthorized Reminder. |
| Active recurring vitamin job lacked `v4` metadata | Every valid Reminder discoverable and manageable through the canonical tool | Live Automation versus direct list | **IMPLEMENTATION DRIFT:** A valid Reminder sat outside the canonical lifecycle. |
| Calendar plugin disabled with invalid provenance | Verified Calendar capability behind deterministic boundary | Live plugin registry | **IMPLEMENTATION DRIFT:** Linked Calendar operations would fail. |
| Skill Workshop job enabled | Zero runtime skills without an exception | Live Automation and canonical architecture | **IMPLEMENTATION DRIFT:** Background LLM could write and run `exec`/`process`. |
| Calendar entries in `alsoAllow` with global subagent deny | Child saw only the Reminder tool; internal deterministic route saw three Calendar tools | Configuration; `tools.effective` unavailable | **UNKNOWN / suspected drift:** Effective policy needed inspection before a decision. |
| `exec` denied but old configuration block remained | No irrelevant `exec` configuration and no `process` | Live configuration and installed 2026.9.4 documentation | Confused ownership and security review. |
| Bare model string | Explicit primary and empty fallback policy | Live configuration | Effective behavior was strict Sol, but intent was implicit. |
| Disabled legacy `agentTurn` Reminder job | Obsolete job archived and retired | Live Automation/history | LLM at fire time, old owner, timeouts, missing delivery metadata. |
| Old dispatch bundles/proposal in active paths | No parallel handoff or skill implementation | Filesystem and no active references | Historical artifacts could be mistaken for sources of truth. |
| Plugin `updatePatch` silently filtered unknown fields | Explicit rejection of unsupported changes | `dist/runner.js` | Recipient/scope change could have unclear behavior. |

There was no workspace drift in the active agent configuration: the active
workspace path was already canonical.

## 7. Capability / tooling / skill decision

The Capability and Skill Decision Gate was completed. The existing Codex/Sol
setup, repository contracts, read-only shell inspection, and OpenClaw CLI were
sufficient for planning and future implementation. No additional Codex skill,
OpenClaw runtime skill, MCP, plugin collection, scheduler, or engineering
framework was justified.

Specifically, `skill_workshop` was not missing; the job promoting it was drift.
`process` was unnecessary because Reminder could not use `exec`. The existing
`tangleclaw-google-oauth` dependency needed provenance/policy repair in the
original proposal; this was not a recommendation to add a new plugin. The
`tools.effective` block arose from local sandbox permissions, not a capability
gap that a skill would solve.

## 8. Ordered implementation stages

### Stage 1 — Checkpoint and close UNKNOWNs

- **Stage objective:** Create a restorable baseline and inspect effective tool policy.
- **Verified problem:** No Git; `tools.effective` was inaccessible in the sandbox.
- **Intended state:** Checkpoint outside canonical directories and proof of tool exposure.
- **Components:** `openclaw.json`, plugin files, Reminder files, recipient configuration, state links, full Automation JSON.
- **Decision:** **KEEP** until inspection justified a change.
- **Exact proposed change:** No active change; create a secure backup under `/home/oa/backups/benson/reminder-recovery-<timestamp>/`, including checksums and an Automation export.
- **Runtime/durable state:** Backup only; no Reminder mutation.
- **Required checkpoint:** Readable backup, parseable JSON, recorded hashes.
- **Validation:** `sha256sum`, `jq empty`, and comparison of job count/IDs with the live inventory.
- **Expected result:** Checkpoint contained all code, configuration, and state needed for rollback.
- **Rollback:** None required.
- **Stop condition:** Incomplete checkpoint, Automation inventory changed during inspection, or no permission to inspect `tools.effective`.
- **Acceptance criterion:** Complete baseline; child/internal effective inventories documented, or Calendar stage explicitly blocked.

### Stage 2 — Repair the canonical executable path

- **Stage objective:** Restore `benson_reminder_service` to the canonical executable.
- **Verified problem:** Runner and `AGENTS.md` used a retired path.
- **Intended state:** Every active reference reached `/home/oa/projects/benson/agents/reminder-service/tools/reminder-service`.
- **Components:** `integrations/openclaw/plugins/benson-reminder-tool/dist/runner.js`, `agents/reminder-service/AGENTS.md`, `agents/reminder-service/tests/test-v3-contract.sh`.
- **Decision:** **REPAIR**.
- **Exact proposed change:** Remove the default `~/.openclaw/workspaces/...` path; resolve from the repository plugin location and verify the canonical realpath. Update `AGENTS.md` and the Main test path. Retain no production environment override that could point to another implementation.
- **Runtime/durable state:** Code/contract only.
- **Required checkpoint:** Stage 1.
- **Validation:** `node --check`, path-resolution test, `bash agents/reminder-service/tests/test-v3-contract.sh`.
- **Expected result:** No active `.openclaw/workspaces/reminder-service` reference; runner invoked only the canonical executable.
- **Rollback:** Restore the three files from the checkpoint.
- **Stop condition:** Ambiguous resolution or a path outside the repository.
- **Acceptance criterion:** Direct runner list returned the same verified result as the direct canonical executable.

### Stage 3 — Reload and verify the live tool

- **Stage objective:** Activate the plugin fix in Gateway.
- **Verified problem:** Registered tool returned `internal_error`.
- **Intended state:** `tools.invoke` succeeded without shell and returned structured JSON.
- **Components:** `benson-reminder-tool`, OpenClaw Gateway.
- **Decision:** **REPAIR**.
- **Exact proposed change:** Use the minimum supported OpenClaw reload/restart mechanism after Stage 2.
- **Runtime/durable state:** Service reload only; no Reminder mutation.
- **Required checkpoint:** Plugin/configuration backup.
- **Validation:** Approved call to `benson_reminder_service` with `operation=list-reminders`.
- **Expected result:** `ok:true`, `verified:true`, and a list identical to the direct core.
- **Rollback:** Restore runner and reload again.
- **Stop condition:** Gateway failed to return healthy or the lists differed.
- **Acceptance criterion:** The sole deterministic Reminder tool worked through OpenClaw.

### Stage 4 — Deterministic recipient authorization

- **Stage objective:** Enforce authorization without narrowing valid capabilities.
- **Verified problem:** No authorization matrix; requester was resolved but not authorized.
- **Intended state:** Explicit allowlist for self, other recipients, and groups, as originally proposed.
- **Components:** `agents/reminder-service/config/recipients.json`, core, discovery, plugin schema, Reminder `AGENTS.md`.
- **Decision:** **EXTEND**.
- **Exact proposed change:** Add explicit requester-to-recipient/group allowlists; require `requesterId` for list/find; check authorization before create/discovery/update/delete/pause/resume; authorize multi-recipient create atomically or fail before mutation.
- **Runtime/durable state:** Policy change; existing jobs unchanged.
- **Required checkpoint:** Secure copy of recipient configuration and operator-approved authorization matrix.
- **Validation:** Test matrix covering authorized self/other/group, unauthorized visibility/mutation, ambiguous alias, and unknown requester.
- **Expected result:** Authorized capabilities survived; unauthorized requests failed before Automation/Calendar calls.
- **Rollback:** Restore code/configuration before deployment; do not return an exposed service to the insecure version.
- **Stop condition:** No authoritative source for the authorization matrix.
- **Acceptance criterion:** Every operation, including list/find, was enforced deterministically.

### Stage 5 — Calendar dependency and authority boundary

- **Stage objective:** Restore Calendar linkage without direct Calendar authority for the Reminder LLM.
- **Verified problem:** Existing plugin was disabled/provenance-invalid; effective policy was unproven.
- **Intended state:** The three Calendar operations were available only to deterministic internal execution.
- **Components:** `tangleclaw-google-oauth`, `openclaw.json`, core Calendar session, `benson-reminder-tool`.
- **Decision:** **REPAIR**.
- **Exact proposed change:** Verify the existing plugin's origin, version, checksum, and authentication; repair provenance through a supported OpenClaw mechanism at a pinned version; enable only after that. Inspect the actual isolated child versus internal Calendar execution session.
- **Runtime/durable state:** Plugin/configuration/reload; test Calendar event during validation.
- **Required checkpoint:** Plugin/configuration/auth-path metadata without copying secrets.
- **Validation:** `tools.effective` showed only `benson_reminder_service` and minimal native capabilities for the child; only `calendar_event_create/get/delete` for internal deterministic Calendar execution; no broader plugin tools exposed.
- **Expected result:** Calendar lifecycle worked through the Reminder tool; the Reminder LLM could not call Calendar tools directly.
- **Rollback:** Disable plugin, restore configuration, verify and remove any test event.
- **Stop condition:** Provenance/authentication could not be verified, or OpenClaw could not provide the required separation.
- **Acceptance criterion:** Controlled linked create/get/delete succeeded with verified cleanup and no direct child exposure.

### Stage 6 — Normalize model and exec policy

- **Stage objective:** Make runtime policy explicit and minimal.
- **Verified problem:** Bare model string and irrelevant `exec` block.
- **Intended state:** Explicit primary, no fallback, no `exec`/`process`, zero skills.
- **Components:** Reminder entry in `~/.openclaw/openclaw.json`.
- **Decision:** **REPAIR**.
- **Exact proposed change:** Convert to `{"primary":"openai/gpt-5.6-sol","fallbacks":[]}`; remove the `exec` configuration block; keep `exec` and `message` denied and `skills: []`; do not add `process`.
- **Runtime/durable state:** OpenClaw configuration/reload only.
- **Required checkpoint:** Exact configuration backup.
- **Validation:** JSON/schema validation, `openclaw agents list --json`, effective tool inspection.
- **Expected result:** Effective model stayed Sol, with no fallback, `exec`, or `process`.
- **Rollback:** Atomically restore configuration and reload.
- **Stop condition:** 2026.9.4 schema rejected the explicit model object.
- **Acceptance criterion:** Behavior remained the same while policy became explicit.

### Stage 7 — Retire the Skill Workshop job

- **Stage objective:** Remove background skill evolution from Reminder.
- **Verified problem:** Enabled `skill-collection-review:reminder-service` with write/exec/process.
- **Intended state:** No Reminder-specific Skill Workshop Automation, as originally proposed.
- **Component:** Job `69023167-e15c-4d80-9194-732a04764575`.
- **Decision:** **RETIRE**.
- **Exact proposed change:** Archive exact JSON; disable; read back; remove; read back again. Do not install `skill_workshop`.
- **Runtime/durable state:** Automation mutation.
- **Required checkpoint:** Complete job declaration/state export.
- **Validation:** Automation list contained neither the ID nor declaration key; `skills: []` remained.
- **Expected result:** No scheduled `agentTurn` able to change the Reminder workspace.
- **Rollback:** Recreate from the archived declaration only if an explicit architectural exception was approved later.
- **Stop condition:** A valid consumer or previously approved exception was found.
- **Acceptance criterion:** Zero runtime skills and zero skill-review background job.

### Stage 8 — Migrate the recurring vitamin Reminder in place

- **Stage objective:** Return an active Reminder to canonical discovery.
- **Verified problem:** Active delivered job was not `v4` and not owned by `reminder-service`.
- **Intended state:** Same job ID, schedule, command payload, route, and delivery; canonical metadata/ownership.
- **Component:** Live Automation named `daily-vitamin-reminder-17-00`.
- **Decision:** **REPAIR**.
- **Exact proposed change:** Resolve the exact live ID; edit description metadata in place using the existing `v4` builder; preserve historical Reminder identity where possible; set canonical agent/session ownership. Do not create a replacement job.
- **Runtime/durable state:** Automation metadata/ownership mutation.
- **Required checkpoint:** Exact pre-edit job JSON and run state.
- **Validation:** Automation get/list, canonical `list-reminders`, job ID comparison, schedule/delivery diff.
- **Expected result:** Same job appeared once in canonical list and remained enabled.
- **Rollback:** Restore exact prior job fields in place.
- **Stop condition:** Edit could not preserve job ID, route, schedule, or delivery state.
- **Acceptance criterion:** Discovery included the recurring Reminder with no duplicate or firing-time change.

### Stage 9 — Retire the disabled legacy job

- **Stage objective:** Remove an old, broken, noncanonical Reminder.
- **Verified problem:** Disabled past `agentTurn` job owned by Main, using Luna, with timeouts and no route account.
- **Intended state:** No legacy scheduled LLM Reminder.
- **Component:** The disabled July 2026 Reminder Automation identified in live inventory.
- **Decision:** **RETIRE**.
- **Exact proposed change:** Resolve the exact current ID; archive full JSON/history; verify it was past and disabled, with no linked Calendar or active dependency; then remove.
- **Runtime/durable state:** Automation removal.
- **Required checkpoint:** Full job declaration and history.
- **Validation:** Job absent; active `v4` and vitamin jobs unchanged.
- **Expected result:** No historical scheduled LLM execution that could be accidentally re-enabled.
- **Rollback:** Recreate in disabled state only from the archive.
- **Stop condition:** Valid future intent or dependency discovered.
- **Acceptance criterion:** Only valid deterministic Reminder jobs remained.

### Stage 10 — Harden contract and tests

- **Stage objective:** Lock in recovered behavior.
- **Verified problem:** Coverage gaps for authorization, plugin path, recurrence changes, groups, multi-match, and Main boundary.
- **Intended state:** Tests covered all canonical contracts.
- **Components:** The two scripts under `agents/reminder-service/tests/`, plugin contract, Reminder `AGENTS.md`, README.
- **Decision:** **EXTEND / REPAIR**.
- **Exact proposed change:** Add tests for authorization, update variants, explicit unknown-field rejection, multiple/group recipients, recurrence, plugin path, `v4` reconciliation, multi-match no-mutation, and notification failure. Update docs for 2026.9.4. Do not change Main logic.
- **Runtime/durable state:** Code/tests/docs only.
- **Required checkpoint:** Stage 1.
- **Validation:** `bash agents/reminder-service/tests/test-v3-contract.sh` and `bash agents/reminder-service/tests/test-reminder-calendar-lifecycle.sh`.
- **Expected result:** Tests ran in an isolated fake runtime and did not touch live Automations/Calendar.
- **Rollback:** Restore changed files.
- **Stop condition:** Test harness accessed live state or left temporary artifacts.
- **Acceptance criterion:** Every contract test passed without a duplicate implementation.

### Stage 11 — Retire obsolete active-tree artifacts

- **Stage objective:** Remove false sources of truth.
- **Verified problem:** Old dispatch bundles and Skill Workshop proposal were unused.
- **Intended state:** No active handoff/output dispatcher or Reminder skill proposal.
- **Components:** `agents/reminder-service/output/dispatch-bundles/` and `/home/oa/.openclaw/skill-workshop/proposals/reminder-service-20260713-e34427056b/`.
- **Decision:** **RETIRE**.
- **Exact proposed change:** Scan dependencies; archive outside canonical directories; remove only after proving no runtime references and that all valid behavior was covered by core/tests.
- **Runtime/durable state:** Filesystem cleanup only.
- **Required checkpoint:** Verified archive with hashes.
- **Validation:** `rg` reference scan, contract tests, live Reminder tool list.
- **Expected result:** No consumer or duplicate source of truth.
- **Rollback:** Restore archive.
- **Stop condition:** Valid behavior not present in canonical code was found.
- **Acceptance criterion:** Active Reminder tree contained only canonical implementation/state.

### Stage 12 — End-to-end acceptance

- **Stage objective:** Prove the complete system through Main.
- **Verified problem:** Component tests did not prove delegation, delivery, or live Calendar.
- **Intended state:** Every flow in Section 9 passed with verification.
- **Components:** Main, Reminder child, plugin, core, Automations, Calendar, WhatsApp.
- **Decision:** **KEEP** architecture; validate repaired implementation.
- **Runtime/durable state:** Temporary Reminders, deliveries, and Calendar events.
- **Required checkpoint:** Fresh Automation/Calendar baseline and unique test tokens.
- **Validation:** Section 9.
- **Expected result:** Structured verified result, correct delivery, no duplicates, complete cleanup.
- **Rollback:** Delete temporary state through the canonical tool; inspect before every retry.
- **Stop condition:** Missing mutation result, failed verification, or unproven cleanup.
- **Acceptance criterion:** Every mandatory E2E scenario passed.

### Stage 13 — Final snapshot

- **Stage objective:** Capture the accepted state.
- **Verified problem:** Existing snapshot was pre-recovery.
- **Intended state:** New snapshot only after acceptance and cleanup.
- **Component:** `bensonsnap`.
- **Decision:** **EXTEND** operational evidence.
- **Exact proposed change:** Run `bensonsnap` once after all stages passed.
- **Runtime/durable state:** Snapshot artifact only.
- **Required checkpoint:** Accepted E2E report.
- **Validation:** Snapshot was readable and contained version, agents, plugins, policies, Automations, and Reminder state.
- **Expected result:** New snapshot without temporary test state.
- **Rollback:** None; a failed snapshot did not change Reminder runtime.
- **Stop condition:** Partial acceptance or unverified cleanup.
- **Acceptance criterion:** Snapshot identified as the post-recovery baseline.

## 9. End-to-end acceptance plan

Every test used a unique token. After a timeout or transport failure,
Automation/Calendar state had to be inspected before a retry.

| Flow | Proof required |
|---|---|
| Main → Reminder | Main spawned a fresh isolated `reminder-service` child; did not choose an ID or call Calendar. |
| Own one-shot create | Verified Automation with future RFC3339 time, correct timezone, and requester route. |
| Relative/local create | Runtime-owned relative base; local time resolved to the correct future time. |
| Authorized other recipient | Job created for an authorized target; immediate secondary notification received. |
| Unauthorized recipient | Deterministic failure before job creation or notification. |
| Multiple recipients | One job per recipient, without duplicates, with atomic authorization. |
| Group recipient | Canonical WhatsApp group route and authorized individual requester. |
| List/find | All matches returned, including migrated vitamin Reminder. |
| Content update | Text changed without changing schedule. |
| Schedule update | Schedule changed without changing content. |
| Recurrence update | One-shot to/from recurring or cron/timezone change according to the contract. |
| Multi-field update | Content and schedule changed in one verified operation. |
| Unsupported recipient/scope update | Explicit structured rejection; no field silently dropped. |
| Multi-match clarification | No mutation; `clarification_required`, one question, and `pendingContext` returned. |
| Continuation | “Do the same for …” or “move it earlier” used explicit prior context and fresh discovery. |
| Multiple-target mutation | “Move both”/“delete those two” neither chose IDs nor performed partial sequential mutation. |
| Pause/resume | Enabled state changed and was read back; linked Calendar remained according to contract. |
| Delete | Automation removed and verified; notification semantics preserved. |
| Calendar-linked create | Event created and read back; link persisted; no duplicate. |
| Calendar-linked update | Replacement event verified; old event removed; content/time synchronized. |
| Calendar-linked delete | Job, event, and link removed with verification. |
| Calendar rollback | Injected verification failure left no orphan job/event/link. |
| Deterministic delivery | Command payload fired without a model run; delivery receipt matched route/account. |
| Notification failure | Reminder state stayed successful; result reported notification failure only. |
| Idempotent retry | State inspected first; retry created no extra Automation or Calendar event. |
| Result envelope | Main received `status/domain/operation/verified/data/warnings/error/pendingContext` and formulated the reply. |

At the end of the suite, all test jobs, Calendar events, and links had to be
removed. Original production jobs had to remain unchanged except for approved
migrations.

## 10. Snapshot requirement

`bensonsnap` was required only after:

1. All code/configuration/runtime migrations were complete.
2. All contract tests passed.
3. All E2E acceptance flows passed.
4. Test Reminders and Calendar events were verifiably cleaned up.
5. Final live inspection proved no duplicate jobs, Skill Workshop job, or stale workspace references.

The new snapshot would be the post-recovery baseline. It could not substitute
for acceptance or be run while Calendar/tool policy remained **UNKNOWN**.

At the time the original plan was presented, it had not been executed. No file,
configuration, Automation, Reminder, or Calendar state had been changed, and
the plan awaited explicit operator approval.
