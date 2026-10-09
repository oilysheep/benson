# Benson Engineering Contract

These instructions govern engineering work in `/home/oa/projects/benson`.

The global Codex engineering policy also applies. Codex's normal instruction
precedence determines which applicable instruction wins; this file adds
Benson-specific constraints at repository-root scope.

Keep architecture in the canonical architecture document, implementation
sequencing/acceptance in the canonical Plan, and scope-specific runtime behavior in
nested `AGENTS.md`. Do not duplicate those owners here.

If effective instruction precedence, a required rule, or a canonical owner for the
current task is unavailable, ambiguous, or contradictory, stop and ask rather than
inventing precedence or a replacement.

**Instruction-load sentinel:** after changing any Benson `AGENTS.md`, verify with a
supported Codex bootstrap/prompt inspection that the applicable instruction chain
is loaded completely and contains the expected end-of-file sentinel
`BENSON_AGENTS_EOF_V1`.

## HARD STOPS

The Builder MUST stop and obtain Oren's explicit approval before:

1. Starting state-changing work for a new SIGNIFICANT stage without stage-start
   approval.
2. Changing architecture, Plan stage/dependency/acceptance strategy, ownership,
   public surface, persistence/lifecycle boundary, security model, or
   workflow/completion semantics.
3. Introducing a new service, store, queue, scheduler, transport, framework,
   plugin registration/state surface, MCP/A2A layer, or OpenClaw core modification.
4. Changing runtime configuration, publishing source to active runtime, or
   reloading/restarting unless that exact exposure is listed in the approved stage
   scope. Every production, user-channel, or physical canary requires explicit
   action-time approval.
5. Launching the first mandatory independent reviewer for a stage, or continuing
   after a reviewer escalation condition.
6. Every push. Push requires applicable validation/acceptance plus final reviewer
   PASS, or Oren's explicit review waiver for a purely EDITORIAL PR.
7. Creating a PR. PR approval is separate from push approval.
8. Merging. Codex MUST NOT merge; Oren merges.
9. Continuing with an unresolved security concern, unverified side effect,
   uncertain execution/ownership state, or inability to fail closed.

Non-negotiable:
- Use the primary checkout only. No worktree, temporary checkout, `/tmp` checkout,
  or parallel repo copy without Oren's explicit exception approval.
- Never claim success without observed evidence at the required acceptance level.
- Never replay a mutation because its result is missing/ambiguous; reconcile prior
  effects first.
- Never remove the last known-good recoverable copy.
- Never request, expose, print, log, snapshot, or embed secrets, credentials,
  private keys, certificates, raw auth files, or secret environment files.
- Never manually edit authentication or secret stores.

## Sources of truth and ownership

### Intended architecture
`architecture/BENSON_SUBAGENT_ARCHITECTURE.md` owns architecture, responsibility
boundaries, deterministic-vs-agentic behavior, OpenClaw ownership, lifecycle,
reliability, security, and observability. Do not restate its detailed design here.

### Current runtime state
Use this precedence:
1. focused current read-only command output;
2. latest valid `benson-context-*.md` snapshot;
3. canonical implementation/configuration;
4. older snapshots and historical context.

Always check snapshot generation time and apply the canonical architecture's rules
for snapshot validity and UNKNOWN evidence. Historical snapshots/conversations are
not current-runtime proof. If verified runtime/implementation differs from approved
architecture, label it **IMPLEMENTATION DRIFT**.

### Owners
- root `AGENTS.md`: Benson-wide engineering workflow;
- nested `AGENTS.md`: scope-specific runtime behavior;
- `PLANS.md`: planning procedure for structural/cross-owner/migration/multi-stage work;
- canonical implementation Plan: active stages, dependencies, migration, acceptance,
  and closure;
- domain plans/contracts: domain capabilities, predicates, and physical evidence.

Before creating a script, skill, tool, policy, config entry, workflow, document
owner, abstraction, or persistence surface, locate the canonical existing owner and
classify existing behavior as KEEP, REPAIR, EXTEND, REPLACE, or REMOVE. Prefer
repair/extension over parallel sources of truth.

## Change classes

### SIGNIFICANT
A change is SIGNIFICANT if it affects architecture/ownership; Plan semantics or
acceptance; any `AGENTS.md`, runtime prompt/policy, or tool guidance; OpenClaw
registration/permissions/models/delegation/lifecycle; runtime config/scheduling/
delivery; persistent schema/state/migration/recovery; deterministic state-changing
domain behavior; user-visible production behavior/external/physical effects; or
requires recovery beyond restoring Git-managed source.

Use the full applicable stage-start, checkpoint, validation, review, approval, and
snapshot rules.

### ROUTINE
A change is ROUTINE only when it:
- stays inside existing approved owners/contracts;
- changes no architecture, Plan semantics, permissions, registration, persistence,
  lifecycle, runtime config, or external behavior;
- adds no new external/physical side effect;
- is safely Git-reversible;
- stays inside the approved design when performed within a stage.

ROUTINE work outside a formal stage skips only the stage-start approval gate. Any
persisted code/config/doc change still uses applicable checkout, branch, validation,
review, push, and PR rules.

### EDITORIAL
A change is EDITORIAL only when wording/formatting changes without affecting
instructions, policy, contracts, acceptance, runtime behavior, or code.

Architecture, Plans, `AGENTS.md`, policies, and runtime instructions are never
EDITORIAL merely because they are text files.

**Anything not clearly ROUTINE or EDITORIAL is SIGNIFICANT.**

A **material post-review change** is any non-EDITORIAL change to the proposed diff;
it requires a new fresh reviewer.

## Engineering workflow

`Inspect → Decide → Backup → Change → Validate → Acceptance → Review → Push → PR → Merge → Snapshot`

Work on one measurable objective or bounded stage at a time.

### Inspect
Start with the smallest sufficient read-only inspection. Establish current
state/evidence freshness, canonical owner/contracts, required/violated invariant,
existing implementation disposition, minimum acceptance evidence, rollback point,
and whether OpenClaw/native behavior must be verified.

Avoid broad dumps and unrelated cleanup/refactoring/migration. Before proposing a
future capability or structural stage, apply the existing-implementation
inventory/disposition procedure owned by `PLANS.md`.

### Decide
Prefer the smallest correct reusable change.

Use a focused patch when the canonical owner is clean and the change is local.
Prefer a clean canonical rewrite when the owner has accumulated duplicate, stale,
superseded, or layered behavior; preserve only approved architecture, verified
requirements, and still-valid behavior.

After a validated REPLACE, remove obsolete active duplicates and verified-unused
stale fragments from canonical directories. Keep rollback material only in the
verified recovery/checkpoint location.

When executing an approved Plan, implement it rather than redesigning it.

Not an architecture decision: a local race fix inside the approved owner, a
regression for the same invariant, or a local validation repair without contract
change.

Architecture/Plan decision: moving responsibility, adding persistence/registration/
public surface, changing workflow finality, weakening acceptance, or replacing a
native lifecycle owner. Changing the boundary is a HARD STOP.

### Backup
For Git-managed source/docs/tests/repo config, the verified pre-change commit/branch
is normally the recovery point. Preserve affected uncommitted content separately.

Before changing runtime config/state, databases, packages, installed artifacts,
persistent domain state, external policy files, or anything else Git cannot safely
restore, create one focused verified restorable checkpoint outside active canonical
directories.

For file-copy checkpoints, capture exact pre-edit targets, hashes, relevant modes,
and restore instructions; verify copies against originals. Record affected scope,
recovery point, restore validation, and effects file rollback cannot undo.

### Change
After stage-start approval, work autonomously through ROUTINE implementation and
validation inside approved scope. Do not stop merely to narrate progress.

Within this phase stop for a HARD STOP, genuine blocker, unapproved operator/
physical/channel action, security concern, or inability to fail closed. All other
gates in this file still apply.

Repair the canonical invariant, not the symptom. Prefer schema/interface/validator
repairs over value-specific exceptions, compensating prompts, duplicate policy, or
parallel owners.

### Validate
While editing, run the smallest regression proving the changed invariant and rerun
only evidence invalidated by each edit. When the bounded diff is stable, run broader
affected validation once. Reuse still-valid evidence; do not rerun unrelated suites
for reassurance.

Passing tests are evidence, not authority. Syntax/unit success does not establish
native lifecycle, provider, channel, runtime, or physical acceptance.

Use deterministic bounded waits/polls/state checks for mechanical observation; do
not spend LLM turns polling runtime/devices.

### Acceptance
Keep evidence levels distinct:
- source/unit/fixture;
- isolated native;
- runtime integration;
- production/user-channel;
- physical.

Never promote one level into another.

Every SIGNIFICANT architecture/runtime or user-facing behavior change requires
representative end-to-end acceptance at the highest applicable approved evidence
level. If production/user-channel/physical E2E is inapplicable or intentionally
deferred, the canonical Plan must record the accepted lower evidence level, reason,
and remaining limitation.

Use bounded equivalence classes, but independently verify identities, mappings,
permissions, authorization, and semantics that cannot safely be inferred.

Prefer Oren performing exact real production interactions followed by deterministic
backend verification for channel/physical actions.

## Unified stage gate and learning template

A primary project goal is for Oren to develop practical Agentic Systems / Harness
Architecture expertise while Benson remains production-quality.

Stage-start, mid-stage decision, and stage-close briefings are concise Hebrew
bullets with a small Benson flow/example when useful. Never omit required fields.

Shared fields:
1. **Flow position/objective**
2. **Invariant/owner/failure class**
3. **Current evidence** — proven / partial / UNKNOWN / drift
4. **Files/components** — expected at start; actual changed at close
5. **Disposition/delta** — KEEP / REPAIR / EXTEND / REPLACE / REMOVE
6. **Component type / OpenClaw vs Benson** — agent, plugin, tool, lifecycle
   integration, Automation, policy/config, persistence, delivery, etc.
7. **Best-practice/native evidence** when external/runtime behavior matters
8. **Validation/acceptance** and evidence level
9. **Runtime exposure** — config/registration/publication/reload/restart/canaries.
   Stage-start approval covers only listed exposure actions; production/user-channel/
   physical canaries still require action-time approval.
10. **Rollback/external effects**
11. **Limits/decisions** — blockers, deferrals, UNKNOWNs, approvals
12. **Learning point** — distributed-systems analogy when genuinely useful

### Stage-start
After minimum read-only inspection, provide the shared fields in planned/future
tense, then STOP for approval before state-changing work in a SIGNIFICANT stage.
Do not ask again for ROUTINE work inside the approved scope.

### Mid-stage decision
For a genuine blocker, architectural discovery, design decision, runtime-exposure
decision, or security concern that requires Oren's decision or changes agreed
design/acceptance/ownership/exposure, give a short Hebrew explanation before asking.
Do not produce tutorial updates for routine work.

### Stage-close / pre-push
After implementation, validation, acceptance, Plan closure, and final reviewer PASS
(or approved EDITORIAL review waiver when applicable), provide the shared fields in
factual tense plus reviewer findings, response changes/dispositions, final review
status, and limitations/UNKNOWNs/deferred follow-up.

This is also the pre-push summary. Then STOP for push approval.

## Git / branch / PR workflow

Default to one SIGNIFICANT canonical stage per branch/PR unless Oren approves other
grouping.

For each stage:
1. branch from latest accepted synchronized `main`;
2. preserve unrelated working-tree changes;
3. commit only stage-owned files;
4. complete validation/acceptance;
5. update canonical Plan closure when applicable;
6. complete independent review and obtain final PASS;
7. give stage-close/pre-push briefing;
8. obtain approval, then push;
9. prepare English PR title/description covering purpose, architectural impact,
   preserved invariants, evidence, and rollback;
10. obtain separate PR-creation approval;
11. create PR against `main` and report it;
12. Codex MUST NOT merge; Oren merges;
13. after merge, synchronize `main`, create/verify any required final accepted-state
    snapshot, then start the next stage.

PR workflow never replaces checkpoint, migration, recovery, acceptance, or snapshot
requirements.

## Independent reviewer gate

Review is mandatory before every non-EDITORIAL PR. A purely EDITORIAL PR may waive
review only with Oren's explicit approval. Architecture, Plan, policy, and
`AGENTS.md` changes are non-EDITORIAL.

### First reviewer
STOP, tell Oren the review gate was reached, and obtain approval. That approval
covers follow-up reviewer runs within the same scope unless escalation is reached.

### Isolation and target
Launch the configured `reviewer` profile as a fresh isolated read-only process.

It must not inherit/fork/resume/receive Builder conversation, hidden reasoning,
session state, Builder summaries/conclusions, or prior reviewer context.

The Builder may pass only target label (stage/capability), diff range or PR
reference, and reviewer profile instructions. The reviewer independently establishes
substantive context.

Review the full proposed change against merge base, including committed/uncommitted
stage changes, approved relevant external policy/config diffs, canonical owner/Plan,
only relevant Architecture/domain contracts/nested `AGENTS.md`, affected code/tests,
and current-state evidence for runtime claims.

Inspect diff first; load minimum sufficient authoritative context.

The reviewer is read-only: no fixes, edits, commits, push, merge, or next-stage work.

Reviewer output:
- PASS or BLOCKED;
- concrete findings;
- acceptance actually established;
- remaining risks/unproven claims;
- merge readiness.

### Findings / repeat review
The Builder explains to Oren in Hebrew what the reviewer found, what was changed or
explicitly dispositioned, and what remains unproven; then validates the resulting
diff.

Any material post-review change requires a new fresh reviewer. If reviewer-driven
changes alter delivered behavior, evidence, limitations, or deferred work, refresh
Plan closure before the next reviewer so it sees the final closure record.

Push is forbidden until the final required reviewer returns PASS.

### Escalation
STOP and ask Oren before another reviewer run when:
- three consecutive BLOCKED rounds occur in the same stage;
- the same blocking finding reappears after a targeted fix;
- Builder/reviewer disagree on architecture, ownership, or acceptance;
- reviewer profile cannot launch;
- canonical review owner cannot be established reliably.

Never substitute Builder self-review.

## Parallel sub-agent use

The Builder may autonomously spawn fresh isolated sub-agents when independent
bounded work is likely to reduce latency or improve evidence quality.

**Parallelize evidence gathering; serialize architectural decisions and overlapping writes.**

The first-reviewer approval applies only to the formal reviewer, not ordinary
parallel investigators.

Parallel sub-agents are read-only by default. Use read-only sandbox/tool policy when
supported; otherwise constrain tasks to read-only operations and do not grant
unnecessary mutation tools.

Keep concurrency bounded and use the smallest number of agents that exposes useful
parallelism.

Good parallel tasks: OpenClaw/API/native-binding research, architecture/design
investigation, race/recovery analysis, test/fixture inspection, source/code-path
inspection, compatibility/version research, and independent hypothesis checking.

Give each sub-agent only minimum sufficient trusted context; do not fork/copy the
Builder's full session by default.

The Builder remains the single implementation owner/integrator. Parallel agents
must not edit overlapping files/owners, independently evolve the same Architecture/
Plan/policy/lifecycle boundary, perform production/runtime/device actions, or create
competing sources of truth.

For genuinely independent implementation work, a sub-agent may produce a patch/diff
for a disjoint owner in scratch output. The Builder remains the only writer/
integrator for the primary checkout unless Oren approves another writer.

### Model/profile selection
Do not hardcode model names here.

Use the currently supported Codex delegation surface. When it supports per-sub-agent
model/profile/reasoning selection, choose from configured capabilities:
- architecture/design/hard diagnosis/native research/ambiguous cross-boundary:
  strongest appropriate reasoning/research profile with high reasoning;
- focused code analysis/implementation planning/test work:
  implementation-oriented profile with sufficient reasoning;
- mechanical inspection: deterministic tools or Builder, not another model.

If the active delegation surface inherits parent model/settings, accept that
inheritance or use an already-configured approved read-only investigator profile
when available. Do not invent orchestration solely to force model switching.

Do not spawn when coordination/token cost exceeds expected benefit.

### Discovery changes the plan
If parallel investigation finds a required Architecture, Plan, ownership,
registration/public-surface, security, or lifecycle-boundary change:
1. freeze dependent implementation;
2. let unrelated read-only work finish only if its assumptions cannot be invalidated;
3. return the finding to the Builder;
4. follow the normal Oren approval gate.

Parallel investigators never replace the formal reviewer.

## Architecture / OpenClaw guardrails

Follow canonical architecture rather than restating it.

Preserve these Benson-wide rules:
- deterministic code/tools for mechanical, repeatable, stateful,
  permission-sensitive, safety-sensitive, externally observable behavior;
- authorization, validation, verification, idempotency, fencing, reconciliation
  close to state-changing operations;
- fail closed when identity, authority, ownership, execution, or outcome is unknown;
- reconcile prior effects before mutation retry;
- never use text matching, timing guesses, model confidence, or run-specific
  heuristics as authority;
- prefer native OpenClaw ownership and supported extension surfaces;
- no MCP, A2A, extra agent framework, custom transport/store/service/scheduler, or
  orchestration boundary merely because it exists.

Any OpenClaw core modification is an explicit exception requiring Oren approval,
version-coupling analysis, checkpoint, rollback, and preferred upstream/native
alternative.

Existing Benson-owned OpenClaw core modifications are IMPLEMENTATION DRIFT to
inventory/preserve pending separately approved disposition; their existence is not
permission to extend, reapply, or delete them.

## OpenClaw capability discovery

For SIGNIFICANT work depending on OpenClaw behavior, establish actual supported
capability before finalizing implementation.

Inspect only as far as needed:
1. current authoritative OpenClaw source for the primitive;
2. current official docs;
3. installed-version implementation/declarations when needed;
4. Plugin SDK / supported lifecycle/tool/config extension surfaces;
5. authoritative production/community evidence when useful.

Record version/provenance. Never infer installed support from online docs alone.

Compare viable alternatives and choose the smallest correct native-first solution.

Before declaring a native mechanism defective, verify its contract, reproduce in
the smallest useful scope, inspect focused runtime evidence and installed
implementation when needed, and separate primitive failure from adjacent
persistence/transport/channel/observability failure.

ROUTINE changes independent of uncertain OpenClaw behavior do not require fresh
research. After OpenClaw upgrade/runtime change, reverify only affected Benson
assumptions.

## Validation, runtime exposure, recovery, snapshots

### Failure remediation
If validation/E2E fails: identify failing layer and violated invariant, distinguish
local defect from structural contract/design weakness, and repair the canonical
boundary/invariant.

Before retrying state-changing work, inspect for effects and preserve idempotency.
Unknown effects remain UNKNOWN and fail closed.

### Runtime exposure
Before approved runtime exposure:
- validate relevant OpenClaw config/registration through the supported path;
- verify exact source/config batch;
- preserve runtime checkpoint;
- minimize reload/restart cycles, normally to one per ready bounded batch.

Source-level PASS is never runtime acceptance.

### Rollback
Rollback shared Git history with a revert commit, not history rewriting. Restore
only compatible affected runtime/config/state/package artifacts. Preserve durable
operation, ownership, idempotency, completion, and frozen-delivery history.

File restoration cannot undo physical commands, external mutations, or sent
messages; reconcile them through the canonical owner.

### Snapshots
A snapshot records accepted/intentionally preserved runtime/config state, not
progress.

After validated changes to OpenClaw config/integration, agents/workspaces,
`AGENTS.md`, deterministic tools/scripts, models/delegation/permissions,
scheduling/Automations, persistent domain state/schema, or canonical architecture,
produce and verify a fresh `bensonsnap`.

For source/document changes, prefer the final snapshot after accepted PR merge and
`main` sync. For runtime/config/domain-state changes, snapshot validated accepted
state when intentionally preserved; if the same stage also changes source, take the
final accepted-state snapshot after merge/sync unless the Plan requires earlier
acceptance evidence.

Do not create snapshots, reloads, or full-suite runs for preparation that does not
change accepted/preserved runtime state.

After changing an `AGENTS.md`, perform the instruction-load sentinel verification
defined at the top; file presence or successful startup alone is insufficient.

## Operator-executed Pi work

When Oren must run commands:
- give one primary command or tightly related block at a time;
- state purpose and read-only/state-changing nature;
- review focused output before continuing.

For each operator-executed code/config/runtime-state change provide exact change and
why, checkpoint/recovery point, one validation command/procedure, expected result,
and rollback when relevant.

Never ask Oren to expose credentials or secret files.

## Implementation language

All NEW Benson implementation uses JavaScript/TypeScript on Node.js, including
plugins, adapters, validators, runtime integrations, deterministic services,
helpers, and tests.

Existing correct Python may remain until separately approved migration. Do not
rewrite it merely for this rule. New adaptation around legacy behavior belongs in
existing or explicitly approved JS/TS owners.

## Language and artifact policy

Communicate with Oren in Hebrew.

Persistent Benson technical artifacts must be English, including architecture,
Plans, `AGENTS.md`, prompts, policies, canonical maintenance docs, durable code
comments, commit messages, and PR titles/descriptions.

Hebrew is allowed in canonical files only as actual domain/user data such as
user-facing strings, room aliases, test utterances, or fixtures.

## Oren learning objective

Benson is both a production-quality home-agent system and Oren's practical
reference architecture for Agentic Systems / Harness Architecture. This is a
primary project goal.

Use the unified gate/decision template; keep explanations concise and practical.
Teaching belongs in stage handoffs, decision briefings, and durable rationale, not
tutorial comments in production code.

<!-- BENSON_AGENTS_EOF_V1 -->
