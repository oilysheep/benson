# Benson Engineering Contract

Global Codex engineering policy and normal precedence apply. Stop and ask if
precedence, required rules or canonical owners are missing, ambiguous or contradictory.

## HARD STOPS

Oren's explicit approval is required before:

1. Mutations in a new SIGNIFICANT stage.
2. Architecture/ownership/public-surface/persistence/lifecycle/security or workflow/
   completion changes; Plan stage/dependency/acceptance-strategy changes.
3. New service/store/queue/scheduler/transport/framework/plugin registration or state,
   MCP/A2A layer, or OpenClaw core modification.
4. Runtime config/publication/reload/restart outside exact approved exposure.
   Every production/user-channel/physical canary still needs action-time approval.
5. First mandatory reviewer or continuation after reviewer escalation.
6. Every push: acceptance and final PASS required, except explicitly waived purely
   EDITORIAL review.
7. PR creation, separately from push.
8. Continuing with unresolved security, unverified effects, uncertain execution/
   ownership or inability to fail closed.

Codex MUST NOT merge; Oren merges. Primary checkout only; worktrees, temporary
checkouts (including /tmp) or parallel copies need explicit exception. Preserve
unrelated changes and last known-good recovery. Success requires observed evidence
at required level; reconcile ambiguous mutations before replay. Never request/expose/
print/log/snapshot/embed secrets, credentials, private keys, certificates, raw auth
or secret environment files; never manually edit authentication/secret stores.

## Owners and evidence

Architecture: architecture/BENSON_SUBAGENT_ARCHITECTURE.md owns responsibilities,
OpenClaw ownership, lifecycle, reliability, security, observability. Root AGENTS.md:
engineering workflow; nested AGENTS.md: scoped runtime. PLANS.md: planning procedure;
canonical Plan: stages/dependencies/migration/acceptance/closure; domain plans/contracts:
capabilities/predicates/physical evidence. Do not duplicate owners. Before adding a
script/tool/skill/policy/workflow/config/document owner/abstraction/persistence, locate
existing owner and classify KEEP/REPAIR/EXTEND/REPLACE/REMOVE.
Current state: focused current read-only output → latest valid benson-context-*.md
→ canonical implementation/config → older evidence. Apply snapshot-time/freshness/
UNKNOWN rules from architecture; history is not runtime proof. Verified divergence
from approved architecture is IMPLEMENTATION DRIFT.

## Change classes

SIGNIFICANT: architecture/ownership; Plan semantics/acceptance; AGENTS.md or runtime
prompt/policy/tool guidance; OpenClaw registration/permissions/models/delegation/
lifecycle; runtime config/scheduling/delivery; persistent schema/state/migration/
recovery; deterministic domain mutations; production/external/physical behavior;
recovery beyond Git. Full stage/checkpoint/validation/review/approval/snapshot rules.
ROUTINE: within approved owners/design, no such boundary/external-behavior change or
new side effect, Git-reversible. Outside a stage skips only stage-start approval,
not checkout/branch/validation/review/push/PR rules.
EDITORIAL: wording/format only, no instruction/policy/contract/acceptance/behavior/code
change. Architecture/Plans/AGENTS.md/policies/runtime instructions are never EDITORIAL
merely because they are text. Unclear means SIGNIFICANT. Any non-EDITORIAL post-review
change is material and requires fresh review.

## Workflow

Inspect → Decide → Backup → Change → Validate → Acceptance → Review → Push → PR → Merge → Snapshot

Apply global inspection/research/repair/hygiene/validation/retention rules; one objective/
stage. Before future capabilities/stages use PLANS.md inventory. Implement approved
design; local race/regression/validation repairs within approved ownership are not redesign.
Backup: verified pre-change commit/branch for Git files; preserve affected uncommitted
content separately. Before non-Git-restorable changes create one verified restorable
checkpoint outside active directories. File copies: exact targets, hashes, modes,
comparison, restore instructions/validation, effects rollback cannot undo. Proceed
within approval until gate/blocker.
Acceptance levels: source/unit/fixture; isolated native; runtime integration;
production/user-channel; physical. Never promote levels. SIGNIFICANT architecture/
runtime/user-facing changes need representative E2E at highest applicable approved
level. For inapplicable/deferred production/channel/physical E2E, canonical Plan records
accepted lower level/reason/limitation. Prefer Oren's exact interaction and deterministic
verification; global equivalence-class/identity-proof rules apply.

## Gate briefings and learning

Primary goals: production quality and Oren's Agentic Systems / Harness Architecture
learning. Hebrew briefings include:

1. Flow position/objective.
2. Invariant/owner/failure class.
3. Evidence: proven/partial/UNKNOWN/drift.
4. Files/components: planned/actual.
5. KEEP/REPAIR/EXTEND/REPLACE/REMOVE delta.
6. Component type; OpenClaw vs Benson.
7. Best-practice/native evidence when external/runtime behavior matters.
8. Validation/acceptance/evidence level.
9. Exact config/registration/publication/reload/restart/canary exposure; only listed
   actions covered, with action-time canary approval.
10. Rollback/external effects.
11. Decisions/approvals/blockers/deferrals/UNKNOWNs.
12. Learning point; Benson example/flow or distributed-systems analogy when useful.

Start: minimal inspection, planned fields, STOP for SIGNIFICANT approval; no repeat
approval for ROUTINE work within scope. Mid-stage: explain genuine blocker or changed
design/ownership/acceptance/exposure/security before asking. Close/pre-push: after
implementation, validation, acceptance, applicable Plan closure and final PASS/EDITORIAL
waiver, factual fields plus findings/responses/dispositions/status/limitations; STOP
for push approval. Teach in briefings/rationale, not routine updates/production comments.

## Git / PR workflow

One SIGNIFICANT stage/branch/PR unless approved otherwise. Branch from latest accepted synced
main; commit stage files only.
Complete acceptance, applicable Plan closure, review, pre-push briefing; approval,
then push. English PR: purpose, architecture impact, invariants, evidence, rollback. Separate creation approval; PR against main; report. Oren merges. Sync main,
verify required accepted-state snapshot, then next stage. PRs replace no checkpoint,
migration, recovery, acceptance or snapshot requirement.

## Independent review

Mandatory for non-EDITORIAL PRs; purely EDITORIAL waiver requires Oren. STOP for first
reviewer approval; it covers same-scope reruns until escalation. Launch configured
reviewer fresh, isolated, read-only: no inherited/forked/resumed Builder conversation,
reasoning, session state, summaries/conclusions or prior reviewer context. Pass only
target label, diff range/PR reference, reviewer profile instructions. Reviewer builds
context independently: diff first, minimum authoritative context.
Review full merge-base change: committed/uncommitted stage and approved relevant
external policy/config diffs; owner/Plan, relevant architecture/domain/nested contracts,
code/tests, runtime evidence. No fixes/edits/commits/push/PR/merge/
next-stage work. Report PASS/BLOCKED, concrete findings, acceptance established,
risks/unproven claims, merge readiness. Explain findings, responses/dispositions and
uncertainty in Hebrew; validate. Refresh Plan closure before re-review if behavior,
evidence, limitations or deferrals changed. Never substitute Builder self-review.
STOP and ask Oren before another run: three consecutive BLOCKED rounds; same blocker after targeted
repair; architecture/ownership/acceptance disagreement; profile launch failure;
unreliable canonical review ownership.

## Parallel sub-agents

Builder may spawn fresh isolated investigators for independent bounded work when
latency/evidence benefit exceeds coordination/token cost. Parallelize evidence;
serialize architecture/overlapping writes. Ordinary investigators need no review approval.
Minimal bounded concurrency/context; no full Builder session copy/fork by default.
Read-only sandbox/tools where supported; otherwise constrain tasks and avoid unnecessary
mutation tools. Builder remains sole implementation owner/integrator/writer unless
Oren approves another writer; disjoint implementation may produce scratch diffs.
No overlapping edits, independent shared Architecture/Plan/policy/lifecycle evolution,
production/runtime/device actions, competing owners or replacement of formal review.
Use supported delegation/configured profiles, no hardcoded models: strongest
appropriate profile/high reasoning for architecture/native research/hard or ambiguous
diagnosis; sufficient implementation profile for code/tests; tools/Builder for mechanics.
Accept inherited settings/existing approved read-only profiles; no orchestration just
to switch models. Architecture/Plan/ownership/registration/public-surface/security/
lifecycle discovery: freeze dependent work, finish only unaffected read-only work,
report to Builder, follow Oren's gate.

## Native behavior and recovery

Enforce canonical architecture's deterministic/authorization/verification/idempotency/
fencing/reconciliation/native-ownership boundaries and fail-closed rules. Text matching,
timing guesses, confidence/run-specific heuristics are not authority. Availability
justifies no extra framework/infrastructure/MCP/A2A/orchestration.
OpenClaw core exceptions require approval, version-coupling analysis, checkpoint,
rollback, preferred upstream/native alternative. Existing core changes: IMPLEMENTATION
DRIFT; inventory/preserve; extension/reapply/deletion require separate approval.
SIGNIFICANT OpenClaw decisions: global research plus installed/SDK evidence; record
version/provenance, compare alternatives, choose smallest correct native option.
Verify installed support, contract/minimal reproduction/runtime evidence before blaming
native behavior; separate primitive from adjacent persistence/transport/channel/
observability failure. ROUTINE work independent of uncertain native behavior needs no new research;
upgrades reverify affected assumptions.
Approved exposure requires supported config/registration validation, exact batch,
runtime checkpoint, minimal reloads (normally one/batch). Source PASS is not runtime
acceptance. Revert shared history; compatible affected restores only. Preserve durable
operation/ownership/idempotency/completion/frozen-delivery history. Reconcile irreversible
physical/external effects/messages via canonical owners; files cannot undo them.

## Snapshots and instruction loading

Verify fresh bensonsnap after validated OpenClaw config/integration, agents/workspaces,
AGENTS.md, deterministic tools/scripts, models/delegation/permissions, scheduling/
Automations, persistent domain state/schema or architecture changes. Capture accepted/
intentionally preserved state, not progress. Source/docs: prefer after accepted merge/
main sync. Runtime/config/domain state: snapshot validated intentionally preserved
state; when source also changes, final snapshot after merge/sync unless Plan needs
earlier evidence. No snapshots/reloads/full suites for preparation alone.

After any AGENTS.md change, use supported prompt inspection (CLI: codex debug prompt-input) at changed/affected descendant scopes. Verify every expected instruction
file's full text loads, including root's final BENSON_AGENTS_EOF_V1 sentinel.
Root sentinel, file presence, byte counts or startup alone cannot prove nested loading.
Keep root-to-scope chains within installed native budget; prefer concise owners over
config increases/parallel policy. Inspect prompts in memory; emit scoped checks, never
raw prompts/secrets.
Unknown/truncated loading blocks acceptance.

## Operator work and language

Oren-executed Pi work: one command/related block; purpose, read-only/mutation status;
inspect focused output before continuing. Changes require exact change/reason,
checkpoint, one validation/expected result, rollback; no secrets.
New implementation/helpers/tests: JavaScript/TypeScript on Node.js. Correct Python
stays until approved migration; new adaptations use existing/approved JS/TS owners.
Hebrew communication; English technical artifacts/comments/commits/PRs. Canonical
Hebrew only for actual domain/user data or fixtures.

<!-- BENSON_AGENTS_EOF_V1 -->
