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

Before changes, define the intended end-to-end flow, measurable Plan acceptance and
minimum sufficient evidence. Use PLANS.md inventory for new stages. Prioritize working
flows in dependency order; continue approved slices through acceptance and stable-candidate
review, not stopping at routine tests, repairs or milestones. If blocked, continue only
independent, approved, safe work. Approval waives no security, effects verification,
fail-closed, rollback or acceptance requirement.

Before mutation, verify Git commit/branch and preserve affected uncommitted/non-Git state
in a verified restorable checkpoint outside active directories: exact targets, hashes/modes,
comparisons, restore/validation and irreversible effects. Batch related changes; reuse valid
coverage, extending it before touching new state. Batch Plan updates at acceptance/material
scope or evidence changes, retaining dated closure. Report genuine gates, not routine ceremony.

Use focused risk-based tests: failure regression first, affected suite once, required
representative E2E. Reuse passing evidence while affected code/native assumptions/freshness
remain valid; broaden only for changed risk, failures or unresolved concerns. Mandatory
acceptance/security checks remain required. Diagnose recurring failures and durable side
effects at the canonical invariant/contract owner; repair the failure class with regression
coverage, not successive value/cardinality-specific fixes, silent fallbacks or weakened limits.
Evidence levels: source/unit/fixture → isolated native → runtime integration →
production/channel → physical; never promote. SIGNIFICANT architecture/runtime/user-facing
changes need representative E2E at highest applicable approved level. Plan records lower
acceptance/reason/limits when production/channel/physical E2E is inapplicable/deferred.
Prefer Oren's interaction and deterministic verification; global identity/equivalence rules apply.

## Gate briefings and learning

One concise Hebrew briefing per genuine gate covers flow/invariant/owner/failure class,
change class/files/disposition (KEEP/REPAIR/EXTEND/REPLACE/REMOVE), Benson/OpenClaw scope,
proven/partial/UNKNOWN/drift, acceptance/evidence level, findings, risks, deferrals,
rollback and exact decision/action. Explain unapproved deltas before asking; specify
runtime/canary actions and effects. Include relevant native/research evidence and useful
Agentic Systems / Harness Architecture learning here, not production comments.
Pre-push: acceptance, Plan closure and final PASS/EDITORIAL waiver; stop unless push
for that final scope is already approved.

## Git / PR workflow

One SIGNIFICANT stage/branch/PR unless approved otherwise. Branch from latest accepted
synced main; commit stage files only. Push only after the gate above and explicit approval.
After approved push, reuse the branch's open PR against main or create it automatically;
verify head/base and report its URL. Never enable auto-merge. English PR bullets cover
What, Why, How, Validation and material Risks, including architecture impact, invariants,
evidence limits and rollback. After Oren merges, sync main and verify the required
accepted-state snapshot before the next stage. A PR replaces no recovery/acceptance gate.

## Independent review

Non-EDITORIAL PRs require review; EDITORIAL waiver requires Oren. Automatically launch
the configured fresh isolated read-only reviewer once after acceptance on a stable integrated
candidate, not each intermediate slice/test/repair. Material changes, finding repairs or
invalidated evidence require fresh review after affected validation and Plan closure;
batch repairs before re-review, subject to escalation below.
No inherited/forked/resumed Builder conversation, reasoning, state, summaries/conclusions
or prior reviewer context. Pass only target label, diff range/PR reference and profile
instructions. Review diff first, full merge-base change including uncommitted stage and
approved relevant external policy/config diffs; independently inspect minimum authoritative
owner/Plan/architecture/domain/nested contracts, code/tests and runtime evidence.
No edits, implementation, Git/publication or next-stage actions. Report PASS/BLOCKED,
referenced findings, established acceptance, risks/unproven claims and merge readiness.
Explain validated dispositions and uncertainty in Hebrew. Builder self-review is no substitute.
STOP and ask Oren before another run: three consecutive BLOCKED rounds; same blocker after targeted
repair; architecture/ownership/acceptance disagreement; profile launch failure;
unreliable canonical review ownership.

## Parallel sub-agents

Fresh isolated investigators: bounded independent work only when evidence/latency benefit
exceeds coordination cost; no review approval needed. Minimize concurrency/context, no full
Builder fork by default; read-only sandbox/tools where supported, otherwise constrain tasks.
Builder is sole writer/integrator unless Oren approves another; disjoint scratch diffs allowed.
Parallelize evidence, serialize architecture/writes. No overlapping edits, independent shared
policy/Architecture/Plan/lifecycle evolution, runtime/production/device actions, competing
owners or replacement of review. Use supported configured profiles, no hardcoded models or
orchestration to switch them: strongest appropriate/high reasoning for architecture/native/
ambiguous diagnosis; sufficient for code/tests; tools for mechanics.
New architecture/Plan/ownership/registration/public-surface/security/lifecycle boundaries:
freeze dependent work, finish only unaffected read-only work, report and follow Oren's gate.

## Native behavior and recovery

Enforce architecture's deterministic/authorization/verification/idempotency/fencing/
reconciliation/native-ownership and fail-closed rules. Text matching, timing guesses,
confidence/run-specific heuristics are not authority; availability justifies no extra
framework/infrastructure/MCP/A2A/orchestration.
Core exceptions require approval, version-coupling analysis, checkpoint/rollback and
preferred upstream/native alternative. Existing core changes: IMPLEMENTATION DRIFT;
inventory/preserve; extension/reapply/deletion need separate approval.
SIGNIFICANT OpenClaw decisions require current research and installed/SDK evidence,
version/provenance, alternatives and smallest correct native option. Prove installed
support/contract/minimal reproduction/runtime behavior before blaming native code;
distinguish persistence/transport/channel/observability failures. Independent ROUTINE
work needs no repeated research; upgrades reverify affected assumptions.
Approved exposure: validate supported config/registration, exact batch, runtime checkpoint,
minimal reloads (normally one/batch). Source PASS is not runtime acceptance. Revert shared
history; compatible affected restores only. Preserve durable operation/ownership/idempotency/
completion/frozen-delivery history. Reconcile physical/external effects/messages through
canonical owners; files cannot undo them.

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
