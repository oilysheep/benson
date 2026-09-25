# Benson Engineering Contract

These instructions govern work under `/home/oa/projects/benson`.
The global Codex engineering policy applies; this file contains only
Benson-specific rules.

## Sources of truth

Use `architecture/BENSON_SUBAGENT_ARCHITECTURE.md` for intended architecture
and responsibility boundaries.

Current runtime precedence:
1. focused current read-only output;
2. latest valid `benson-context-*.md` snapshot;
3. canonical implementation/configuration;
4. older snapshots or historical context.

Check snapshot generation time before treating it as current. If verified
runtime differs from intended architecture, identify implementation drift.

Nested `AGENTS.md` files own runtime behavior for their agents; do not duplicate
those responsibilities here.

Use `PLANS.md` only for structural, cross-owner, migration, architecture-
significant, multi-stage, or otherwise durable planned work.

## Workflow and plan ownership

Use:

Inspect → Decide → Backup → Patch/Rewrite → Validate → Acceptance → Snapshot

Work on one measurable objective or bounded substage at a time.

Before changing anything, inspect the smallest sufficient current state, locate
the canonical owner, choose repair/extension/replacement, and identify the
minimum sufficient acceptance evidence.

Prefer the smallest correct reusable change. Do not create duplicate
implementations or parallel sources of truth.

When executing an approved canonical plan, implement it and record
status/evidence there. Do not change its stage structure, dependencies,
acceptance strategy, or architectural decisions. If execution evidence requires
such a change, stop and return that evidence for a planning/operator decision.

## Architecture boundaries

Follow `architecture/BENSON_SUBAGENT_ARCHITECTURE.md`.

Required boundaries:
- Benson Main is the central cognitive orchestrator;
- deterministic Request, Completion, and Response control owns the respective
  boundaries, with Response Controller as the interactive outbound boundary
  before native delivery;
- domain sub-agents own domain reasoning and approved tool selection;
- sub-agent runs are fresh/isolated unless explicitly approved otherwise;
- persistent behavior must not depend on hidden LLM session state;
- domain sub-agents have zero runtime skills by default unless approved;
- use least privilege and explicit allowlists;
- stateful, permission-sensitive, safety-sensitive, and externally observable
  operations belong in deterministic tools;
- keep authorization, validation, guardrails, verification, idempotency, and
  reconciliation close to state-changing operations;
- fail closed when outcome cannot be verified.

Prefer native OpenClaw orchestration. Do not add MCP, A2A, another agent
framework, custom orchestration, or a new infrastructure boundary without a
concrete benefit and explicit approval.

If a repair changes an architectural boundary, stop after Decide, compare viable
designs, and obtain Oren's approval.

## Efficient Benson execution

Batch related safe work into meaningful units.

For a meaningful Git-managed source/docs/tests/repository-config batch:
- require a verified pre-change Git commit/branch as the source rollback point;
- use Git diff/history/commits for source evidence and rollback; do not duplicate
  Git-managed source into Benson checkpoints.

For a meaningful runtime/config/state/package batch:
- create one verified restorable Benson checkpoint before the batch for artifacts
  that Git cannot safely restore;
- use targeted tests while editing;
- run broader affected validation once when the batch is ready;
- validate OpenClaw config before runtime exposure when relevant;
- minimize gateway reload/restart cycles, normally one per ready batch;
- use representative production E2E only where external behavior must be proven;
- run `bensonsnap` after meaningful validated acceptance, or when a validated
  runtime/config state must be preserved for safe continuation or rollback.

Do not create checkpoints, snapshots, reloads, or full-suite runs for trivial
intermediate preparation unless recovery/evidence specifically requires them.

Prefer parameterized deterministic tools, executors, validators, and checkers
when capability instances share semantics and verification. Do not create
room/value/canary-specific mechanisms when safe parameters suffice.

Use bounded equivalence classes for representative acceptance, but independently
verify identities, mappings, permissions, or semantics that cannot be inferred.

Use deterministic bounded waits/polls/state checks; do not spend LLM turns
polling runtime or device state.

Work autonomously until a genuine Oren gate, architectural decision, physical
E2E, or blocker. Do not stop only for routine progress narration.

## Backup, failure, and rollback

Before destructive, state-changing, config-changing, or structurally significant
work, establish a verified rollback point. For Git-managed source, docs, tests,
and repository configuration, use the verified pre-change Git commit/branch.
For active runtime configuration, runtime state, databases, packages, installed
runtime artifacts, or anything Git cannot safely restore, create the verified
Benson checkpoint required by the bounded batch outside active canonical
directories. Never remove the last known-good recoverable copy.

Before retrying a mutation, inspect prior side effects.

For Benson failures, identify the failing layer and invariant, distinguish local
defect from structural weakness, repair the canonical owner, and preserve
fail-closed behavior.

Never repair malformed completion by replaying a domain mutation. Never use
text matching, timing guesses, or run-specific values instead of proper
identity, correlation, provenance, or ownership.

Rollback Git-managed source through Git. For already-pushed shared source
history, prefer a new revert commit over rewriting history. Restore only affected
compatible runtime/config/state/package artifacts from the applicable verified
Benson checkpoint, and preserve durable operation/idempotency history.

## Validation and production acceptance

Never claim success without observed validation. Do not rerun unrelated
already-passing tests or acceptance scenarios unless the changed surface could
invalidate them.

Meaningful user-facing changes require representative E2E. Prefer Oren
performing the real production interaction followed by deterministic backend
verification.

If E2E fails, inspect durable state and side effects first; do not blindly retry.

## OpenClaw, snapshots, security, language

After a meaningful OpenClaw upgrade or harness/runtime change, reverify only the
Benson assumptions that depend on changed native behavior. Prefer current
installed behavior and authoritative current OpenClaw documentation over
historical assumptions.

A snapshot records an accepted or intentionally preserved runtime/config state;
it is not a progress marker. Do not run `bensonsnap` for preparation-only or
trivial intermediate states.

After meaningful validated changes to OpenClaw config, agents, workspaces,
`AGENTS.md`, deterministic tools/scripts, models, delegation, permissions,
scheduling, domain state, or canonical architecture, produce and verify a fresh
snapshot.

Never request or expose passwords, API/OAuth tokens, private keys, certificates,
secret environment files, or raw authentication files. Do not manually edit
authentication or secret stores.

Communicate with Oren in Hebrew. All persistent Benson technical artifacts must
be English only.
