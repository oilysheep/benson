
# Benson Engineering Contract

Global Codex policy applies. Inspect routine uncertainty; stop for mandatory-rule conflicts or missing canonical ownership. This governs engineering, not runtime agents.

## Flow-First Development

Deliver a small, safely bounded **working vertical slice** through the real user flow early. Define E2E acceptance, trusted identities, safety invariants and trace correlation first. Fix the first broken boundary, test narrowly, **return to E2E**. Avoid speculative hardening and verification infrastructure.

Measure accepted capabilities, time to E2E, reliability, cost and operator effort; not test/review/checkpoint counts. E2E never waives safety, authority or recovery.

## Owners and evidence

`architecture/BENSON_SUBAGENT_ARCHITECTURE.md` owns system architecture and runtime invariants; root `AGENTS.md` engineering; nested `AGENTS.md` scoped agents; `PLANS.md` planning procedure; canonical implementation Plan stages/acceptance; domain plans capabilities and physical predicates. Locate existing owners before adding behavior; choose KEEP/REPAIR/EXTEND/REPLACE/REMOVE. No duplicate policy, controller, verifier, store, scheduler, framework or source of truth.

Current fact order: focused read-only runtime output → newest valid timestamped `benson-context-*.md` → implementation/config → historical evidence. Intent is not runtime proof; verified divergence is IMPLEMENTATION DRIFT. Distinguish source/unit, isolated native, runtime, channel and physical evidence; never promote a lower level. UNKNOWN is not PASS or zero effect. Approved Phase 2 deferrals belong solely in `PHASE2_BACKLOG.md` with reason, limits, revisit criteria and references.

## Risk classes and authorization

Classify **risk/exposure**, not implementation complexity:

- **SIGNIFICANT:** architecture, ownership, public contract, persistent state/schema, security/authorization, native lifecycle/recovery, runtime instructions/policy, stage acceptance strategy or externally observable behavior changes.
- **ROUTINE:** bounded repairs/implementation within approved owners and contracts, with no new authority, irreversible effect or architectural boundary.
- **EDITORIAL:** wording/format only, with no behavior, contract, policy or acceptance change. A policy text edit is not editorial. Unresolved classification is SIGNIFICANT.

**Approval inheritance:** An approved bounded objective covers routine inspection, repairs, tests, review and acceptance. Do not reapprove mechanics, local findings or intermediate PASS. Stop only for new authority.

### Hard stops — explicit new operator decision required

1. A new SIGNIFICANT objective/boundary outside approved scope: architecture, ownership, contracts, security, permissions, lifecycle or acceptance.
2. New infrastructure or registration (service/store/queue/scheduler/transport/plugin, MCP/A2A, orchestration framework), or an OpenClaw core modification.
3. Authentication/secret operations; production, physical or user-channel exposures not covered by a current exact approval envelope.
4. Failed required safety guard, unreconciled previous state-changing outcome, uncertain effect/authority, or inability to fail closed or recover safely.
5. Push (Oren approval) and merge (Oren only); any stricter applicable canonical Plan or host/sandbox authorization gate remains binding.

**Scoped operational authorization:** One action-time approval may cover an E2E session with multiple controlled Gateway starts/stops/restarts, reloads and named canaries. Bound owner/channel/device, allowed effects, attempt/time limits, preconditions, stop conditions, recovery and expiry. No approval per covered step; code-stage approval alone never authorizes production. No unlisted config, permissions, recipients, physical actions or higher-risk experiments.

Before retrying a mutation reconcile prior effects, state and attempt budget; UNKNOWN prohibits blind replay. Stop on changed risk/scope, unsafe state or expiry. Never bypass host controls or downgrade a safety gate without justified approval.

Preserve unrelated changes, Git branch integrity and last-known-good recovery. Use the primary checkout; temporary/parallel worktrees need explicit exception. Never request/expose/log/snapshot credentials, raw authentication, keys, certificates or secret environments; never manually modify authentication/secret stores.

## Delivery loop

**Inspect → Decide → Recoverable baseline → Small change → Focused validation → Scoped E2E → Required review → Publish → Snapshot.**

Define the user flow, acceptance, trusted provenance, owned invariants and smallest E2E slice. `PLANS.md` governs new stages. Inspect narrowly; use deterministic native tools for mechanics instead of agentic orchestration.

Reach integrated/channel E2E after essential preflight; do not wait for unrelated hardening. Physical/irreversible effects need effect-time authority, fencing and recovery; otherwise deliver a smaller read-only/nonphysical slice.

**Risk-based checkpoints:** Maintain recoverable baseline. Clean committed Git may cover reversible ROUTINE source changes; protect dirty/untracked files. SIGNIFICANT, destructive, config, non-Git or runtime mutations need a verified checkpoint **outside active directories**, with affected state/hashes and tested restore conditions.

Reuse when coverage/freshness/later changes are protected. Not one per repair/restart. Never lose last good copy or native/effect history; file rollback cannot undo effects.

**Checkpoint retention:** After accepted merge and verified recovery/snapshot, identify safely superseded checkpoints and remove only those with no remaining recovery, rollback or required evidence dependency. Preserve the last known-good restorable copy, essential E2E evidence and unresolved failure records. Obtain required destructive-operation approval. Do not delete by age alone or accumulate unnecessary nested checkpoint trees.

**Risk-based validation:** Reproduce failure, add focused regression, run affected tests and mandatory safety negatives, then approved representative E2E. Reuse valid results; rerun suites only for invalidation/new risk. Label source-only evidence honestly; unsupported verifier predicates are not product requirements.

Finish the approved bounded objective rather than stopping at a subtask or PASS. If a real gate blocks one capability, continue only independent approved safe work. Update the existing canonical Plan at material decisions/closure, not every probe.

## E2E diagnosis and verifier discipline

Trace the actual execution using existing correlated logs and component evidence:

**Ingress → Request Controller → Main or Direct Domain → Domain Execution → DomainResult / Controlled Completion (as applicable) → Response Controller → Native Delivery.**

When Main delegates, the domain result returns to Main before Main's terminal response and Response Controller authorization. Direct-domain paths must not invent a Main Run. Controlled Completion applies only when an actual Domain Agent Run executes.

Correlate original input, Session, Run, tool calls, results, effects, authorization and delivery. Locate the **first failed boundary and violated invariant**.

Classify product, verifier, test fixture, infrastructure, native-contract and model failures separately before changing code. Repair the canonical cause, not symptoms.

**Test Benson-owned behavior, not OpenClaw internals.** Trust supported native lifecycle/persistence contracts. SQLite maintenance, leases, cache, retention and unrelated timestamps need checks only when a supported contract and concrete Benson risk justify them. Authorization, data integrity, effects, disclosure and recovery are **blocking safety gates**; observability diagnostics are not.

Before extending a verifier, state the exact otherwise-uncovered Benson invariant, its existing owner and the cheapest authoritative proof. If absent, do not add it.

Repeated BLOCKED findings in verification infrastructure—or recurrence after a focused repair—require immediate review of the *verifier contract*, not serial narrow patches. Repair locally within scope; escalate architectural/authority redesign decisions.

Never create a permanent diagnostic tool without recurring demonstrated need. Test production-relevant topology (e.g. separate agent workspaces) when it matters.

## Independent review — risk-proportional

Assess high-risk contracts, authority and verifier assumptions before coding. This is a risk/design assessment, **not an automatic requirement for an additional independent review before implementation**. Obtain pre-implementation independent review only when a concrete architectural/security decision or applicable Plan gate requires it.

Fresh isolated read-only final review is mandatory for SIGNIFICANT/safety-critical changes and any applicable Plan gate. ROUTINE work is reviewed when risk warrants; stricter existing Plan gates apply until explicitly reconciled.

Review a stable integrated candidate, not every interim patch. Give the reviewer only diff/range, canonical owners and minimum evidence; no Builder reasoning or session inheritance.

Review the actual whole changed scope and report PASS/BLOCKED, findings and unknowns. Builder self-review is not independent review.

Fix local findings and retest autonomously, then re-review only materially changed evidence/bytes; reuse an applicable uninvalidated PASS. Reviewers never mutate/publish.

A reviewer launch/model-capacity failure means **REVIEW_NOT_COMPLETED**, not a technical BLOCKED. Retry safely with backoff up to three times; never silently change mandatory model, isolation or reviewer.

Escalate persistent unavailability or real architecture/security disagreement. Repeated technical BLOCKED demands root-cause reassessment, **not an automatic stop after three rounds**.

## Git, publication, learning

Normally one SIGNIFICANT stage/branch/PR. Branch from accepted synchronized `main`, commit only the scoped files, protect unrelated work.

Before push: accepted evidence, required review, Plan closure and a concise Hebrew brief on working E2E, remaining gaps, risks and rollback.

**Push requires explicit approval; Codex never merges.**

After approved push, reuse/create the PR, verify head/base and never auto-merge. English PR: What, Why, How, Validation, Risks.

After Oren merges, sync main and verify the accepted-state `bensonsnap` when required.

**Learning loop:** After meaningful E2E or recurring delay, record first failed boundary, bad assumption, fix, acceptance, wasted iterations and one prevention in existing Plan/evidence. No new journal.

Measure future time to E2E and approvals; skip ceremony for ordinary fixes.

## Runtime, isolation and recovery

Preserve deterministic-first ownership, source authority, least privilege, currentness, idempotency, fencing, reconciliation and fail-closed behavior.

A model instruction is not an authorization boundary. Native/API claims require installed SDK/contract proof for the relevant version; use smallest supported solution, not private OpenClaw internals, unnecessary core patches or another agent framework.

Existing core modifications remain IMPLEMENTATION DRIFT pending accepted replacement.

For approved exposure validate config/registration, loaded source/permissions, health, actual user/physical effects and compatible recovery.

API success, provider ACK and human reading are different claims. No blind replay of unknown effects; keep durable operation/ownership/delivery history. Avoid unrelated cleanup during E2E diagnosis.

Fresh isolated investigators may research bounded independent questions when useful; Builder is the only writer. Parallelize evidence, not conflicting owners/policy/state or runtime changes.

Use configured appropriate models; deterministic tools for mechanics. No new orchestration to manage the engineering workflow.

## Snapshots, instructions and communication

Use `bensonsnap` after accepted config/integration, AGENTS, agent/workspace, tool, model/delegation, permissions, automation, domain-state or architecture changes.

Source/doc snapshot normally follows merge/main sync; runtime snapshots document validated preserved state. No progress snapshots or unnecessary suite repeats.

After root/nested AGENTS changes, verify complete instructions at affected scopes via supported `codex debug prompt-input` and OpenClaw bootstrap where applicable.

Check full file bytes (not just `BENSON_AGENTS_EOF_V1`) within native budgets. Inspect in memory; output no raw prompts or secrets. Truncation/UNKNOWN blocks acceptance.

For operator-run Pi steps, provide one focused command/block, reason, read-only or state-changing classification, expected validation and rollback; inspect the result.

Speak Hebrew; write prompts, engineering policies, technical artifacts, commits/PRs in English.

New tests/scripts use existing JS/TS/Node owners; preserve working Python until a separately approved migration.

<!-- BENSON_AGENTS_EOF_V1 -->
