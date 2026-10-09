> **Historical deployment record — precedence clarified 2026-10-09.** The chronological sections below retain their original stage-time facts and recovery evidence. Early CLI/allowlist/source-copy descriptions do not establish current deployment or authorize restoring removed executables. Use the latest valid snapshot and focused inspection for installed state, the [Architecture](../../architecture/BENSON_SUBAGENT_ARCHITECTURE.md) for target ownership, the [root Implementation Plan](../../BENSON_DECISION_ROUTING_IMPLEMENTATION_PLAN.md) for event-driven migration and the [Full Capability Plan](FULL_CAPABILITY_PLAN.md) for accepted domain scope. No shared event service, pending-cleaning feature or deferred conditional action is claimed deployed by this documentation update.

> The revised Architecture is approved; source admission, no-Run validation, native delivery and exact physical completion remain distinct implementation proofs. Future trusted external-start device alerts cannot imply task completion or ownership release. D5's proposed hours remain unapproved for runtime implementation. Apply the root Plan's migration/rollback gates before any deployment; this record authorizes none.

# Jessica source and deployment

`src/` is the Benson-owned source baseline imported in Stage 1. Each file was
copied byte-for-byte from the currently deployed executable:

| Benson source | Current deployment |
| --- | --- |
| `src/jessica` | `/usr/local/bin/jessica` |
| `src/jessica-read` | `/usr/local/bin/jessica-read` |
| `src/jessica-control` | `/usr/local/bin/jessica-control` |

OpenClaw's Jessica `exec` allowlist still targets the deployed paths. Stage 1
does not alter those executables, the allowlist, Home Assistant, or runtime
behavior. The pre-import checkpoint and restore rehearsal are recorded under
`output/checkpoints/benson-jessica-20260919T112621Z/`.

Future changes should be made to the Benson-owned source and deployed only
after the relevant stage's validation and acceptance. Treat the copies in
`/usr/local/bin` as deployed artifacts, not editing targets.

## Stage 2 domain core

`lib/` contains closed request/result validation, a map-bound room resolver,
capability checks, a default-deny policy loader, and preparation of read/control
plans. `config/registry.v1.json` records the reviewed room and capability
mapping; `config/policy.v1.json` lists the five approved family members for
read and control, with default deny. The filtered
HA map fixture and contract tests are under `tests/`.

The current map names segments 13 and 14 `Room 13` and `Room 14`, so the
historical `home_center` and `tal_room` aliases are disabled. Balconies remain
blocked. Kitchen shortcut 32 is represented as a disabled declarative
three-pass workflow. Every physical capability remains below the `verified`
threshold and is rejected by the domain core. Future native adapters must
supply trusted runtime identity and fresh HA evidence outside tool arguments.

## Stage 3 native read adapter

`integrations/openclaw/plugins/benson-jessica-tool/` registers the optional
`jessica_read` tool only for `jessica-vacuum`. OpenClaw allows that tool for
Jessica only. The tool exposes `status`, `rooms`, and `capabilities`; it uses
the Stage 2 domain core and validated result envelopes. Home Assistant access
is limited to a GET of `vacuum.jesica_jesica` through `lib/ha-read.mjs`.

Requester identity comes from OpenClaw's trusted delivery context and the
canonical private WhatsApp route roster. It is never accepted from tool
arguments. Groups without a trusted per-sender identity fail closed. The
approved family roster must agree exactly with the Jessica policy at plugin
load time. Unverified physical capabilities remain disabled. The deployed
`/usr/local/bin` executables and Jessica's legacy `exec` allowance remain in
place until their planned later-stage replacement.

The Stage 3 checkpoint is
`output/checkpoints/benson-jessica-stage3-20260919T175905Z/`. Rollback restores
the checkpointed OpenClaw config, Jessica policy, registry, and this document;
then remove the new plugin directory and `lib/ha-read.mjs`, revert the Stage 3
`lib/domain-core.mjs` and test changes, validate config, and restart the
OpenClaw gateway. No Home Assistant state was changed by Stage 3.

## Stage 4 isolated execution source

`integrations/openclaw/plugins/benson-jessica-tool/dist/executor.js` implements
the control state machine against an injected HA driver. It validates trusted
identity and an external request epoch supplied by the caller, then records a
durable intent before a single dispatch. It verifies fresh device evidence
before returning success. `dist/operation-state.js` uses OpenClaw's native
sync plugin-state store, namespace `jessica-operations-v1`, to serialize this
device and retain epoch results. Uncertain dispatch remains durable and blocks
resending; reconciliation is read-only. Full-home cleaning is blocked until
the result contract can prove task scope.

`tests/executor.test.mjs` runs against `tests/fake-ha.mjs` over a temporary
Unix socket with temporary OpenClaw state. The tests cover duplicate requests,
conflicts across processes, crash recovery around dispatch, timeouts, missing
attributes, target mismatch, and partial settings. The fake registry marks
selected capabilities verified only in test memory. Production registry
support remains unchanged, and the live plugin still registers only
`jessica_read`. No Stage 4 write tool or production HA driver is deployed.

The pre-change checkpoint is
`output/checkpoints/benson-jessica-stage4-20260919T184150Z/`. To roll back
Stage 4 source, restore checkpointed files and remove the five new Stage 4
source/test files (`dist/executor.js`, `dist/operation-state.js`,
`tests/executor.test.mjs`, `tests/executor-worker.mjs`, and
`tests/fake-ha.mjs`). This isolated stage leaves no production operation
state. In a future live rollout, do not delete any unresolved intent during
rollback; retain it for read-only reconciliation.

## Stage 5 conversation and completion boundary

Jessica's short `AGENTS.md` limits reasoning to the current semantic request
and the `jessica_read` tool. Main's Jessica contract requires a fresh isolated
child for each external request and a native completion followed by
`jessica_validate_completion`. The validator uses the native parent task row
and native child transcript to compare final JSON with the deterministic
Jessica tool result. It rejects stale, malformed, or altered completions and
returns only a validated envelope or an unverified error. No custom delivery,
completion router, or handoff file is used.

OpenClaw's Jessica tool allowance is `jessica_read` only; `exec` is removed.
The validator is available only to Main. All physical capabilities remain
unverified in the production registry. The Stage 4 executor remains source
for later canaries and is not registered as a production write tool in Stage 5.

Stage 5 checkpoint:
`output/checkpoints/benson-jessica-stage5-20260919T221403Z/`. Roll back
contracts, plugin, and configuration separately from any future model choice.
Restoring the checkpointed OpenClaw configuration can re-enable Jessica's
former `exec` allowance, so do not do that automatically; preserve the narrow
read-only tool policy. No Stage 5 device or operation state is created.

## Stage 6 first-room acceptance

Oren sent one direct production request to clean `guest_bathroom` (segment
10) without settings. The native tool used the Stage 4 executor and
`dreame_vacuum.vacuum_clean_segment`. Operation
`j4-a6766e87921efd52f199a6fe0102e23e` returned `started` after fresh
`room_cleaning` and exact active segment evidence. The durable one-shot claim
is retained in OpenClaw plugin-state namespace `jessica-operations-v1`.
Oren observed physical cleaning, then completion and return to docking; a
subsequent authenticated HA GET reported `docked`, `active_segments:null`,
and task status `completed` without error. The historical evidence remains
auditable with `node agents/jessica-vacuum/tests/check-stage6-canary.mjs after`.

The registry records only `guest_bathroom` in `clean_single_room.verifiedRooms`.
Global `clean_single_room.support` remains `reported`; every other room is
unverified. The canonical policy grants identical read and control permission
to all five approved family members. Group mutations require trusted native
per-sender identity; unknown or untrusted senders are denied. The native
`jessica_execute` adapter exposes only the verified room and no settings.
No other write capability is enabled. Never resend an uncertain operation.

The pre-canary checkpoint is
`output/checkpoints/benson-jessica-stage6-20260920T105602Z/`; the promotion
checkpoint, including a consistent post-canary SQLite backup, is
`output/checkpoints/benson-jessica-stage6-promotion-20260920T113606Z/`.
The equal-family-policy checkpoint is
`output/checkpoints/benson-jessica-stage6-family-policy-20260920T115127Z/`.
Rollback disables `jessica_execute` exposure first, then restores only the
affected source/config from the applicable checkpoint while preserving the
durable canary and other OpenClaw operation state. Never restore the entire OpenClaw database over
other domains. Any next physical canary requires a new operator gate.

## Stage 6 closure: narrow v1

Stage 6 is closed with one technically verified write capability:
`clean_single_room` for `guest_bathroom` (segment 10), without settings. The
global `clean_single_room` capability remains `reported`, not `verified`;
`verifiedRooms` is the only positive room-scoped evidence. The production
canary passed deterministic dispatch/result acceptance, and Oren observed
cleaning followed by completion and docking. The durable operation and
one-shot claim remain retained. No further physical command was used for
closure.

The following writes are explicitly outside v1 and remain unverified or
disabled in the registry: cleaning every other room, `clean_multi_room`,
`clean_home`, the kitchen three-pass workflow, cleaning settings,
`pause`, `resume`, `stop`, and `dock`. Multi-room target/order evidence is
missing. The current result contract cannot prove a full-home task scope.
The inspected HA vacuum and task-status history did not expose a task
identifier suitable for same-task control verification; `active_segments:null`
is not treated as proof of a task or target. No verification predicate was
relaxed to enable these operations. The native write adapter still exposes
only the verified room-cleaning request.

Authorization is independent of technical verification. All five approved
family members have identical full control over any capability that becomes
verified and enabled; no permanent Oren-only rule exists. Unknown identities
fail closed, and group mutation requires trusted per-sender identity. The
registry/domain core decide capability availability; the canonical policy
decides requester authorization.

Stage 7 is an expansion gate, not an automatic rollout. Its scope requires
operator approval before any settings, station, or preset extension, and
each selected extension requires its own checkpoint, focused validation, and
physical canary. The Stage 6 closure checkpoint is
`output/checkpoints/benson-jessica-stage6-closure-20260920T121559Z/`.

## Stage 7 suction extension (one verified room and value)

The canary tested one `suction` setting value for a clean of the already
verified `guest_bathroom`, with no global `clean_settings` verification. Oren
sent the request through production Benson once. The deterministic `after`
check passed for operation `j4-53f733b1ecc5a9dd176c8410124bdc47`:
`strong` was applied and the guest-bathroom clean started. A later HA read
showed the task completed and the vacuum docked. The selector and vacuum still
reported `strong`; no compensating setting change has been approved. Oren
confirmed that the vacuum cleaned and returned to dock. The temporary
`underTest` scope was removed. The registry now records only the verified
`guest_bathroom` + `strong` pair under `clean_settings`; global settings,
other values, and other rooms remain unverified. The canonical family policy
grants this technically enabled pair equally to every approved family member.

The original canary used a temporary `clean_settings` scope naming the room,
one suction value, an expiry, and two permitted dispatch steps. The existing
operation-state claim bound both the selector update and room clean to one
request epoch. The native adapter now exposes only the verified room and
setting pair; the HA driver permits only `select.select_option` for the reviewed
selector/value and the already reviewed segment-cleaning command. The executor
requires a fresh selector timestamp and read-back when changing suction, and
the vacuum's own suction value must match during the cleaning transition. If
`strong` is already set, the verified path skips the redundant selector POST,
requires fresh read-back and matching vacuum suction, then verifies the room
cleaning transition. An under-test canary still requires a setting transition. A
missing or conflicting signal remains unverified and cannot trigger a resend.
Read-only HA inspection found `select.jesica_suction_level` at `turbo` with
`quiet`, `standard`, `strong`, and `turbo` options, and confirmed the
`select.select_option` service. The inspected selector update preceded a
vacuum state transition, so the selector's own timestamp is required for
setting verification. Current values must be rechecked at canary preflight.

`tests/check-stage7-suction-canary.mjs` is the deterministic preflight and
after-check owner. The fresh activation checkpoint is
`output/checkpoints/benson-jessica-stage7-suction-activation-20260920T131646Z/`;
it includes the registry, policy, plugin source/config, consistent operation-state
SQLite backup, and live suction baseline. The plugin was reloaded and `preflight`
passed after reload. The scoped setting was promoted only after operator physical
observation, from checkpoint
`output/checkpoints/benson-jessica-stage7-suction-promotion-20260920T135301Z/`.
Restore the original suction setting only after task and operation
state are reconciled, using a separately approved safe action; file rollback
cannot undo a device setting. The source
preparation checkpoint is
`output/checkpoints/benson-jessica-stage7-suction-prep-20260920T122820Z/`.

A cleaning-completion notification is not part of this extension. It requires
durable correlation to the exact operation and a reviewed outbound delivery
owner; `docked` alone is not sufficient evidence for a user-facing completion
claim.

## Stage 7 closure and Stage 8 legacy retirement

Stage 7 closes with one justified extension: `strong` suction for a
`guest_bathroom` clean. Mode, wetness, station, presets, other suction values,
and other rooms remain unverified and disabled. The verified pair is available
to every approved family member under the unchanged canonical policy.

Stage 8 caller inspection found no active OpenClaw agent, Cron, systemd, Main,
plugin, or maintenance caller of the three legacy CLI executables. Jessica's
live tool policy exposes only `jessica_read` and `jessica_execute`, not `exec`.
The old source and deployed binaries are retained in the verified checkpoint
`output/checkpoints/benson-jessica-stage8-migration-20260922T052050Z/`. The
legacy source has been retired from its active path. The operator removed
the three deployed executables from `/usr/local/bin` on 2026-09-22; a focused
local check confirmed all three paths absent. No active caller was identified
before removal, and Jessica's live OpenClaw tool policy exposes only the
canonical tools. Earlier stage sections above are historical deployment
records, not current CLI instructions. To roll back the retirement, restore
the exact checkpointed files and binaries, then validate tool exposure; do
not replay any physical command.

Stage 8 production E2E passed on 2026-09-22. Oren sent a direct read-only
capability question to Benson and observed the scoped capability answer.
Native Jessica task `c8d713dc-3061-41e2-b9a8-0f0441e9802d` succeeded and
was delivered with exactly one tool use, `jessica_read`. The answer matched
the registry's sole verified room (`guest_bathroom`) and sole verified setting
(`strong` suction for that room). The durable Jessica operation-state entries
showed no new request record since the 2026-09-20 Stage 7 canary. Together
with the confirmed absence of the three deployed legacy binaries, focused
active-reference search, valid OpenClaw configuration, healthy gateway, and
the verified checkpoint, this closes Stage 8 without another physical action.
