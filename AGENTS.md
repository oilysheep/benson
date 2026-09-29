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

Always check snapshot generation time before treating it as current. If verified
runtime differs from intended architecture, explicitly identify implementation
drift.

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

Inspect → Decide → Backup → Patch/Rewrite → Validate → Acceptance → Snapshot

Work on one measurable objective or bounded stage at a time.

Start with the smallest sufficient read-only inspection. Establish the current
state, canonical owner, relevant invariant, minimum sufficient acceptance
evidence, and appropriate rollback point before changing state.

Prefer the smallest correct reusable change. Patch when the canonical owner is
clean and the change is local. If it has accumulated drift, duplication, stale
behavior, or layered patches, prefer a clean canonical rewrite based on intended
architecture and verified current requirements.

When executing an approved canonical plan, implement it rather than redesigning
it. Do not change stage structure, dependencies, acceptance strategy, or
architectural decisions without presenting the evidence and obtaining Oren's
approval.

Work autonomously through routine implementation and validation. Stop for a
genuine architecture decision, operator approval gate, physical E2E action,
security concern, or blocker; do not stop merely to narrate routine progress.

## Stage branch, plan closure, and PR workflow

For each meaningful stage of an approved canonical multi-stage plan:

- start a dedicated branch from the latest accepted and synchronized `main`;
- keep one canonical stage per branch and PR unless Oren explicitly approves
  combining stages;
- preserve unrelated working-tree changes; never include, revert, overwrite, or
  clean them as part of the stage;
- commit only files owned by the stage;
- complete required validation and acceptance before proposing the PR;
- after acceptance, update the canonical implementation plan with a short factual
  closure record containing acceptance status, implemented delta, validation and
  acceptance evidence, meaningful design deviations, and known limitations or
  explicitly deferred follow-up;
- never mark a stage accepted before the required evidence has been observed;
- push the accepted stage branch to `origin`;
- give Oren the required end-of-stage Hebrew learning explanation defined below;
- prepare an English PR title and description covering purpose, architectural
  change, preserved invariants, validation/acceptance evidence, and rollback;
- obtain Oren's explicit approval before creating the PR;
- after approval, create the PR against `main` and report its reference;
- never merge automatically; merging requires separate explicit Oren approval
  after the PR has been created and reviewed;
- start the next stage only after the previous PR is merged and local `main` is
  synchronized with `origin/main`.

The closure record belongs in the same PR as the stage implementation and is not
a work log or transcript. PR workflow does not replace required rollback points,
runtime checkpoints, validation, acceptance, recovery, or snapshots.

### Manual independent pre-merge review

When Oren explicitly requests a pre-merge review, run a fresh independent
Codex process using the configured `reviewer` profile from the target
checkout/worktree. Reviews are manual and must not start automatically.

When the request is made from an active Builder Codex session, the Builder must
launch that independent reviewer process itself, wait for it to finish, and
return the reviewer report to Oren. The Builder must not substitute its own
review or pass its reasoning/session context to the reviewer.

Use the PR plus the stage, capability, or domain named by Oren as the review
target. The reviewer must independently establish the minimum sufficient
authoritative context for that target:

- inspect the PR diff against its merge base first to identify the affected
  owners and surfaces;
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
documents, or builder-session reasoning. Builder summaries and passing tests
are evidence, not authority.

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

Every meaningful implementation stage has two Hebrew learning gates. Use concise,
concrete bullet points and a small Benson flow/example rather than abstract prose.

### Stage-start learning gate

After only the minimum read-only inspection needed to ground the explanation,
and before implementation or state-changing work, explain:

- where the stage sits in the Benson flow and what surrounds the boundary;
- the concrete problem/invariant, failure risk, and responsible owner;
- the canonical files/components expected to be inspected or changed;
- the intended architecture/data/control flow and a concrete example when useful;
- the completion evidence and relevant distributed-systems analogy when useful.

This describes intent and planned architecture, not claimed results.

### End-of-stage learning gate

After implementation, validation, acceptance, and the plan closure record, and
before presenting the PR proposal, explain:

- what was actually implemented and where it sits in the Benson flow;
- the enforced invariant and failure class prevented;
- meaningful differences from the plan and why the chosen boundary owns them;
- concrete validation/acceptance evidence and any remaining limitation or deferral;
- the relevant distributed-systems analogy when useful.

This describes the implemented and proven result, not the original plan.

For a meaningful blocker, architectural discovery, design decision, or runtime
change inside a stage, also give a brief Hebrew explanation when it materially
affects Oren's understanding or requires an operator decision.

Keep explanations concise and accessible. Define unfamiliar agentic/OpenClaw
terminology when needed.

## Validation, rollback, recovery, and snapshots

Never claim success without observed validation.

For Git-managed source, documentation, tests, and repository configuration, use
the verified pre-change Git commit/branch as the rollback point. Use Git
diff/history/commits for evidence and rollback; do not duplicate Git-managed
source into Benson checkpoints.

For active runtime configuration, runtime state, databases, packages, installed
runtime artifacts, or anything Git cannot safely restore, create one verified
restorable Benson checkpoint outside active canonical directories before the
bounded change. Never remove the last known-good recoverable copy.

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

## OpenClaw maintenance

After a meaningful OpenClaw upgrade or harness/runtime change, reverify only the
Benson assumptions affected by changed native behavior.

Before concluding that a native OpenClaw mechanism is defective or unsuitable,
verify the current documented contract, reproduce the behavior in the smallest
useful scope, inspect focused runtime evidence and installed implementation when
necessary, and distinguish the primitive from adjacent transport, persistence,
channel, or observability failures.

Prefer focused current runtime evidence and authoritative current OpenClaw
documentation over historical assumptions.

## Security and language

Never request, expose, print, log, snapshot, or embed passwords, API/OAuth
tokens, credentials, private keys, certificates, secret environment files, or
raw authentication files. Do not manually edit authentication or secret stores.

Communicate with Oren in Hebrew. All persistent Benson technical artifacts,
including plans, architecture, `AGENTS.md`, prompts, policies, maintenance
instructions, commit messages, and PR titles/descriptions, must be English.
