# Benson Engineering Contract

Global Codex engineering policy and normal precedence apply. Stop and ask if
precedence, required rules or canonical owners are missing, ambiguous or contradictory.

## HARD STOPS

Oren's explicit approval is required for unapproved scope below;
canaries need action-time approval:

1. Mutations in a new SIGNIFICANT stage.
2. Architecture/ownership/public-surface/persistence/lifecycle/security or workflow/
   completion changes; Plan stage/dependency/acceptance-strategy changes.
3. New service/store/queue/scheduler/transport/framework/plugin registration or state,
   MCP/A2A layer, or OpenClaw core modification.
4. Authentication actions; runtime config/publication/reload/restart outside exact approved exposure.
   Every production/user-channel/physical canary still needs action-time approval.
5. Continuation after reviewer escalation.
6. Every push: acceptance and final PASS required, except explicitly waived purely
   EDITORIAL review.
7. Continuing with unresolved security, unverified effects, uncertain execution/
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
capabilities/predicates/physical evidence. Before adding any persistent surface, locate
its existing owner; classify KEEP/REPAIR/EXTEND/REPLACE/REMOVE. Do not duplicate owners.
Current-state precedence: focused current read-only output → latest valid benson-context-*.md
→ canonical implementation/config → older evidence. Apply architecture snapshot/freshness/
UNKNOWN rules; history is not runtime proof. Verified architectural divergence is IMPLEMENTATION DRIFT.

Oren-approved Phase 2 task/decision deferrals MUST update PHASE2_BACKLOG.md, the sole
index, with rationale, current limitation, revisit criteria and canonical references;
deduplicate. Unapproved ideas are not decisions. Never silently alter current-phase
acceptance, security invariants or architecture.

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

Continue exact approved scope through validation, acceptance and automatic review until
a HARD STOP, operator action or blocker; ask only for unapproved deltas. Batch related
inspection/checkpoints/edits/validation/reporting. Approved local repairs are not
redesign. Use PLANS.md inventory before future stages.
Approval never waives security, fail-closed, verification, rollback or acceptance.
Backup: verify Git commit/branch; preserve affected uncommitted content. Non-Git state:
one verified restorable checkpoint outside active directories. Copies: exact targets,
hashes/modes, comparison, restore/validation and irreversible effects.
Reuse checkpoints only while recovery coverage remains valid; cover new affected state
before mutation. Reuse valid unchanged evidence; rerun for relevant changes, failures,
freshness or unresolved concerns. Batch Plan updates at acceptance/material scope/evidence
changes; retain required closure and dated evidence.
Evidence levels: source/unit/fixture → isolated native → runtime integration →
production/channel → physical; never promote. SIGNIFICANT architecture/runtime/user-facing
changes need representative E2E at highest applicable approved level. Plan records lower
acceptance/reason/limits when production/channel/physical E2E is inapplicable/deferred.
Prefer Oren's interaction and deterministic verification; global identity/equivalence rules apply.

## Gate briefings and learning

Goals: production quality and Oren's Agentic Systems / Harness Architecture learning.
One concise Hebrew briefing per genuine gate covers applicable fields:

1. Objective/flow; invariant, owner and failure class.
2. Proven/partial/UNKNOWN/drift; validation, acceptance and evidence level.
3. Planned/actual files, KEEP/REPAIR/EXTEND/REPLACE/REMOVE; Benson vs OpenClaw/type.
4. Best-practice/native evidence; exact approved runtime/canary actions, rollback/effects.
5. Findings/dispositions, limitations, decisions, approvals, blockers and deferrals.
6. Learning point/example when useful.

Start: STOP for unapproved SIGNIFICANT scope. Mid-stage: explain the blocker/unapproved
delta before asking. Close/pre-push: validation, acceptance, Plan closure and final
PASS/EDITORIAL waiver precede one briefing; STOP unless push already approved for this
final scope. Avoid redundant reports; teach here, not production comments.

## Git / PR workflow

One SIGNIFICANT stage/branch/PR unless approved otherwise. Branch from latest accepted synced
main; commit stage files only.
Complete acceptance, applicable Plan closure, review, pre-push briefing; approval,
then push. After a successful approved push, reuse the open PR for that branch
against main; otherwise create it automatically without separate approval. Verify
the PR head/base and report its URL. Never enable auto-merge; Oren merges.
English PR descriptions use concise, accessible bullets covering What, Why, How,
Validation and material Risks; include relevant architecture impact, invariants,
evidence, limitations and rollback. Sync main, verify the required accepted-state
snapshot, then next stage. PRs replace no checkpoint, migration, recovery,
acceptance or snapshot requirement.

## Independent review

Non-EDITORIAL PRs require review; EDITORIAL waiver requires Oren. Automatically launch
the configured fresh isolated read-only reviewer once on the stable final diff.
Rerun for material changes, finding repairs or invalidated evidence; escalation below
still applies. No inherited/forked/resumed Builder conversation,
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

Verify bensonsnap for accepted OpenClaw config/integration, agents/workspaces,
AGENTS.md, deterministic tools/scripts, models/delegation/permissions, scheduling/
Automations, domain state/schema or architecture changes. Source/docs: after accepted
merge/main sync. Runtime/state: capture validated preserved state; with source changes,
final capture after merge/sync unless Plan needs earlier evidence. Reuse only a verified
fresh snapshot of that state; no progress/preparation snapshots, reloads or full suites.

After AGENTS.md changes, inspect prompts (`codex debug prompt-input`) at affected scopes.
Verify each expected file's full text and BENSON_AGENTS_EOF_V1; sentinel/counts/presence/
startup cannot prove nested loading. Keep chains within native budget; prefer concise
owners over config increases/parallel policy. Inspect in memory; emit checks, never prompts/secrets.
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
