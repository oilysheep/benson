# Benson Engineering Contract

These instructions govern engineering work under `/home/oa/projects/benson`.
The global Codex engineering policy also applies. Keep this file limited to
Benson-wide engineering rules; scope-specific runtime behavior belongs in the
applicable nested `AGENTS.md`.

## Sources of truth and ownership

Use `architecture/BENSON_SUBAGENT_ARCHITECTURE.md` as the canonical source for
intended architecture and responsibility boundaries. Do not duplicate its
detailed design here.

For current runtime state use this precedence:

1. focused current read-only command output;
2. latest valid `benson-context-*.md` snapshot;
3. canonical implementation and configuration;
4. older snapshots and historical context.

Follow architecture Section 2 for snapshot freshness, UNKNOWN evidence and
IMPLEMENTATION DRIFT. Historical decisions do not establish current runtime.

Nested `AGENTS.md` files own scope-specific runtime behavior. Do not duplicate
their instructions here or create parallel behavioral sources of truth.

Use `PLANS.md` only for structural, cross-owner, migration,
architecture-significant, multi-stage, or otherwise durable planned work.

Before creating a script, skill, tool, policy, config entry, workflow, document,
or abstraction, locate the canonical existing owner and decide whether to repair,
extend, or cleanly replace it. Avoid duplicate implementations and parallel
sources of truth.

## Engineering workflow

Use:

Inspect → Decide → Backup → Focused Change/Rewrite → Validate → Acceptance → Snapshot

Work on one measurable objective or bounded stage at a time.

Start with the smallest sufficient read-only inspection. Establish the current
state, canonical owner, relevant invariant, minimum sufficient acceptance
evidence, and appropriate rollback point before changing state.

Prefer the smallest correct reusable change. Make a focused change when the
canonical owner is clean and the change is local; use a clean canonical rewrite
when accumulated drift, duplication or superseded behavior warrants it. Follow
the global policy's document/source hygiene and recovery-retention rules.

Apply the existing-implementation inventory and disposition procedure in
PLANS.md before proposing a future capability or implementation stage.

When guiding operator-executed work on the Pi, provide one primary command or
command block, explain its purpose and review focused output before proceeding.
For each code/configuration change, report the exact change, a validation command
or procedure, its expected result and a rollback note when relevant.

When executing an approved canonical plan, implement it rather than redesigning
it. Do not change stage structure, dependencies, acceptance strategy, or
architectural decisions without presenting the evidence and obtaining Oren's
approval.

After the required stage-start approval, work autonomously within the approved
scope through routine implementation and validation. Stop at the next genuine
architecture decision, operator approval gate, physical E2E action, security
concern, or blocker; do not stop merely to narrate routine progress.

## Stage branch, plan closure, and PR workflow

Default to one meaningful canonical stage per branch and PR, including approved
documentation stages, unless Oren explicitly approves different grouping.
Before state-changing work, provide the stage-start briefing and satisfy the
stage-start approval gate below. Approval is scoped to the current stage; do not
request it again once explicitly granted.

For each stage:

- start a dedicated branch from the latest accepted and synchronized `main`;
- preserve unrelated working-tree changes; never include, revert, overwrite, or
  clean them as part of the stage;
- commit only files owned by the stage;
- complete required validation and acceptance before proposing the PR;
- for implementation stages governed by an approved canonical plan, after
  acceptance update that plan with a short factual closure: acceptance status,
  implemented delta, validation/acceptance evidence, meaningful design deviations
  and known limitations or explicitly deferred follow-up;
- never mark a stage accepted before the required evidence has been observed;
- give Oren the end-of-stage Hebrew learning explanation defined below;
- complete the independent review approval gate below before every PR;
- after final reviewer PASS, stop, provide the pre-push summary below and
  obtain explicit Oren approval before EVERY push to the remote repository;
- only then push the accepted stage branch to origin;
- prepare an English PR title and description covering purpose, architectural
  change, preserved invariants, validation/acceptance evidence, and rollback;
- obtain Oren's explicit approval before creating the PR;
- after approval, create the PR against `main` and report its reference;
- Codex MUST NOT merge; Oren performs the merge;
- start the next stage only after the previous PR is merged, local main is
  synchronized with origin/main, and any required accepted-state snapshot is
  available.

The closure record belongs in the same PR as the stage implementation and is not
a work log or transcript. PR workflow does not replace required rollback points,
runtime checkpoints, validation, acceptance, recovery, or snapshots.

Before every push, summarize in Hebrew the objective, prior state, actual
change and implementation, architecture/OpenClaw relationship, changed owners
and files, observed validation, acceptance status, checkpoint/rollback,
limitations/unknowns and learning points. Prior push approval does not authorize
another push. PR creation approval is separate from push approval.

### Independent review approval gate before PR

Before every PR, the Builder must STOP and tell Oren that the mandatory
independent review gate has been reached. The first reviewer run requires
Oren's explicit approval.

After approval, the Builder launches a fresh independent read-only Codex process
using the configured `reviewer` profile from the target checkout/worktree and
receives its findings directly. Oren does not need to manually open or launch
the reviewer session or copy/paste reviewer reports. The Builder may launch it
from the current Builder workflow/session, but must not substitute its own review.

Every independent review run MUST use a fresh isolated reviewer process/session.
The reviewer MUST NOT inherit, fork, or receive the Builder conversation,
reasoning context, hidden session state, summaries, or prior reviewer context.
Reusing an existing reviewer conversation/session is not allowed. The reviewer
starts only from the final proposed diff plus the minimum authoritative project
sources it independently reads.

The Builder fixes or explicitly dispositions findings, validates the resulting
changes, and explains to Oren what was found and changed. If fixes materially
change the proposed diff, automatically launch a new fresh isolated reviewer
process/session for another independent review of the final proposed diff. The
initial review approval covers follow-up reviews needed to resolve findings
within the approved scope. Review is complete only after a final independent
reviewer PASS; then stop at the pre-push approval gate above.

Use the final proposed diff plus the stage, capability or domain named by Oren
as the review target; include the PR if one already exists. Before PR creation,
review the full proposed change against the merge base, including uncommitted
stage changes and any approved external policy diff. The reviewer must
independently establish the minimum sufficient authoritative context:

- inspect that final diff first to identify the affected owners and surfaces;
- locate the canonical plan or document that owns the target rather than
  assuming a fixed Benson-wide plan;
- read the relevant target stage/section and its dependencies, validation,
  acceptance, rollback, and stop/approval conditions;
- read only the canonical architecture sections needed by that target or by
  concrete questions raised by the diff;
- when domain code is affected, read the applicable domain-owned canonical
  plans, contracts, and nested `AGENTS.md` files as relevant;
- inspect the affected surrounding code and the tests that provide acceptance
  evidence.

Do not broadly load unrelated plans, domains, architecture sections, historical
documents, or builder-session reasoning. Passing tests are evidence, not
authority.

If the PR makes claims about current runtime state or runtime acceptance, apply
the repository's normal current-state evidence precedence rather than treating
historical plans or conversations as current proof.

The reviewer must remain read-only and must not fix findings, modify the PR,
commit, push, merge, or start the next stage.

The reviewer must return PASS or BLOCKED, concrete findings, acceptance
criteria actually established, remaining risks or unproven claims, and merge
readiness.

If the configured `reviewer` profile cannot be launched, or the canonical
owner for the review target cannot be established reliably, report that and
stop. Do not substitute a review from the builder session.

## Architecture guardrails

Follow the canonical architecture rather than restating it here.

- Prefer deterministic code and tools for mechanical, repeatable, stateful,
  permission-sensitive, safety-sensitive, and externally observable operations.
- Keep authorization, validation, guardrails, verification, idempotency, and
  reconciliation close to state-changing deterministic operations.
- Fail closed when an outcome, identity, ownership relationship, or state change
  cannot be verified.
- Before retrying a state-changing operation, inspect whether the previous
  attempt already produced side effects.
- Repair the canonical owner or violated invariant. Prefer parameterized schemas,
  interfaces, tools, and validators over value-specific exceptions or
  compensating prompt logic.
- Do not substitute text matching, timing guesses, or run-specific values for
  identity, correlation, provenance, ownership, or deterministic validation.
- Prefer native OpenClaw orchestration and primitives. Do not add MCP, A2A,
  another agent framework, custom orchestration, transport, store, service, or
  infrastructure boundary without a concrete architectural benefit and Oren's
  explicit approval.

If a proposed repair changes an architectural boundary, stop after Decide,
compare viable canonical designs, and obtain Oren's approval before implementation.

## Oren learning and explanations

A primary goal of Benson engineering is for Oren to develop practical Agentic
Systems / Harness Architecture expertise.

Every meaningful engineering stage has two Hebrew learning gates. Use concise,
concrete bullet points and a small Benson flow/example rather than abstract prose.

### Stage-start learning gate

After only the minimum read-only inspection needed to ground the explanation,
and before implementation or state-changing work, explain:

- where the stage sits in the Benson flow and what surrounds the boundary;
- the concrete problem/invariant, failure risk, and responsible owner;
- the canonical files/components expected to be inspected or changed;
- what already exists, what is correct/partial, and the PLANS.md disposition:
  what remains untouched, changes, is removed or is newly created, and why;
- the intended architecture/data/control flow and a concrete example when useful;
- the OpenClaw primitive, how the component is registered and whether it is an
  agent, plugin, tool, lifecycle integration, Automation, policy/config surface,
  persistence owner or delivery owner; distinguish native from Benson ownership;
- relevant best-practice evidence, validation and observable acceptance criteria;
- checkpoint/rollback, effects file restoration cannot undo, important unknowns
  and approval gates; include a distributed-systems analogy when useful.

This describes intent and planned architecture, not claimed results.

After this briefing, STOP for every meaningful implementation stage. Do not
begin any state-changing work until Oren explicitly approves starting that
stage. Approval of a plan or an earlier stage is not approval to start the
current stage.

### End-of-stage learning gate

After the change, validation, acceptance and any applicable plan closure, and
before presenting the PR proposal, explain:

- what was actually implemented and where it sits in the Benson flow;
- the enforced invariant and failure class prevented;
- what stayed correct and unchanged, actual implementation dispositions, and
  meaningful differences from the plan and why the chosen boundary owns them;
- the actual OpenClaw integration/registration and responsibilities retained by
  OpenClaw versus those added by Benson;
- concrete validation/acceptance evidence, rollback and remaining limitations,
  unknowns or deferrals;
- the practical engineering lesson and relevant distributed-systems analogy.

This describes the implemented and proven result, not the original plan.

For a meaningful blocker, architectural discovery, design decision, or runtime
change inside a stage, also give a brief Hebrew explanation when it materially
affects Oren's understanding or requires an operator decision.

Benson is both a production-quality home agent system and Oren's practical
reference architecture. Connect the principle to the OpenClaw primitive, Benson
owner/code, runtime behavior and verification. Keep explanations concise and
accessible; define unfamiliar terms. Teaching belongs in handoffs and useful
canonical rationale, not tutorial comments in production code.

## Validation, rollback, recovery, and snapshots

Never claim success without observed validation.

Before destructive, state-changing, configuration-changing or structurally
significant work, establish a verified restorable checkpoint outside active
canonical directories. Identify affected paths/state, validation, expected
result, restoration procedure and external/physical effects that file rollback
cannot undo. Never remove the last known-good recoverable copy.

For Git-managed source, documentation, tests and repository configuration, the
verified pre-change commit/branch is normally the source recovery point. Preserve
any affected uncommitted content separately. When Oren explicitly requires file
copies, checkpoint the exact pre-edit targets, including external policy files,
with hashes, relevant modes and restore instructions; verify copies against the
originals. Avoid unnecessary broad repository backups.

For active runtime configuration/state, databases, packages, installed runtime
artifacts or anything Git cannot safely restore, create one focused restorable
Benson checkpoint outside active canonical directories before the bounded change.

Use targeted tests while editing, then run broader affected validation once the
bounded change is ready. Do not rerun unrelated already-passing suites unless the
changed surface could invalidate them.

Use bounded equivalence classes for representative acceptance, but independently
verify identities, mappings, permissions, and semantics that cannot be inferred.
Use deterministic bounded waits, polls, and state checks for mechanical
observation; do not spend LLM turns polling runtime or device state.

Validate OpenClaw configuration before runtime exposure when relevant. Minimize
gateway reload/restart cycles, normally to one per ready bounded batch.

Meaningful user-facing changes require representative E2E. Prefer Oren performing
the real production interaction followed by deterministic backend verification
when a physical or user-channel action is required.

If validation or E2E fails, identify the failing layer and violated invariant,
distinguish a local defect from a structural contract/design weakness, and apply
the Architecture guardrails above. Never replay a domain mutation merely to
repair malformed or ambiguous completion evidence.

Rollback Git-managed shared history with a new revert commit rather than rewriting
history. Restore only affected compatible runtime/config/state/package artifacts
from the applicable verified checkpoint, preserving durable operation and
idempotency history.

A snapshot records an accepted or intentionally preserved runtime/config state;
it is not a progress marker. Do not create checkpoints, snapshots, reloads, or
full-suite runs for trivial preparation unless recovery or evidence requires them.

After meaningful validated changes to OpenClaw configuration, agents, workspaces,
`AGENTS.md`, deterministic tools/scripts, models, delegation, permissions,
scheduling, domain state, or canonical architecture, produce and verify a fresh
`bensonsnap`.

## OpenClaw capability discovery and maintenance

Before finalizing the implementation approach for every meaningful stage,
establish what current OpenClaw already provides, including the required
lower-level primitives. Inspect, in order:

1. the actual current OpenClaw repository/source;
2. current official OpenClaw documentation;
3. installed-version implementation when needed;
4. the Plugin SDK and supported lifecycle/tool/config extension surfaces;
5. relevant current authoritative best practices and useful production/community
   evidence.

Compare viable alternatives and their trade-offs, then choose the smallest
correct solution. Do not build Benson-specific functionality before this
discovery justifies it. Trivial mechanical edits do not require fresh research.

Establish version/provenance; never infer a checkout path or installed support
from current online documentation alone. Apply the global research gate and
architecture Section 7.6 for extension preference, core immutability and its
explicit exception gate. Existing core changes are implementation drift to
inventory for later disposition, not permission to extend or remove them.
Do not duplicate a harness responsibility that OpenClaw already owns adequately.

After a meaningful OpenClaw upgrade or harness/runtime change, reverify only the
Benson assumptions affected by changed native behavior.

Before concluding that a native OpenClaw mechanism is defective or unsuitable,
verify the current documented contract, reproduce the behavior in the smallest
useful scope, inspect focused runtime evidence and installed implementation when
necessary, and distinguish the primitive from adjacent transport, persistence,
channel, or observability failures.

Prefer focused current runtime evidence and authoritative current OpenClaw
documentation over historical assumptions.

## Implementation language

All NEW Benson implementation code uses JavaScript/TypeScript on Node.js,
including plugins, adapters, validators, runtime integrations, deterministic
services, helpers and tests. Do not introduce new Python infrastructure.
Existing correct Python may remain until a separately approved migration; do
not rewrite it solely to meet this rule. New adaptation around legacy behavior
belongs in existing or approved new JS/TS owners.

## Security and language

Never request, expose, print, log, snapshot, or embed passwords, API/OAuth
tokens, credentials, private keys, certificates, secret environment files, or
raw authentication files. Do not manually edit authentication or secret stores.

Communicate with Oren in Hebrew. All persistent Benson technical artifacts,
including plans, architecture, engineering/runtime AGENTS.md, prompts, policies,
canonical technical/maintenance documentation, durable engineering code comments,
commit messages and PR titles/descriptions, must be English. Hebrew is permitted
inside canonical files only as actual domain/user data, such as user-facing
strings, room aliases, test utterances or fixtures.
