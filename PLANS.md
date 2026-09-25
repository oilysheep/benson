# Benson Implementation Planning Standard

This file defines how Codex should plan non-trivial engineering work on Benson.

It is a planning procedure, not an architecture source of truth.

The canonical intended architecture remains:

`architecture/BENSON_SUBAGENT_ARCHITECTURE.md`

The engineering rules and current-state precedence in the root `AGENTS.md`
remain authoritative.

## When to use this planning procedure

Use this procedure for work involving one or more of:

- architecture or responsibility boundaries;
- OpenClaw configuration;
- agents, delegation, tools, skills, or permissions;
- deterministic domain tools or scripts;
- runtime behavior or state;
- scheduling or delivery;
- migrations or recovery;
- multiple implementation files;
- externally observable or safety-sensitive behavior.

Do not create planning ceremony for a trivial, obvious, low-risk change.

Plans are normally working artifacts in the Codex conversation.
Do not create additional plan files in the active Benson tree unless there is
a concrete reason for a durable plan document.

## Planning objective

Produce the smallest executable plan that can move the verified current system
to the intended architecture safely and measurably.

A good Benson plan must optimize for:

1. correctness and reliability;
2. preservation of valid existing capabilities;
3. minimum sufficient change;
4. security and least privilege;
5. deterministic execution where appropriate;
6. native OpenClaw mechanisms where appropriate;
7. maintainability and one source of truth;
8. token and context efficiency;
9. latency and operational simplicity.

Do not optimize for novelty, framework count, skill count, abstraction count,
or amount of code changed.

## Phase 1 — Establish the objective

State:

- the exact problem to solve;
- the desired externally observable outcome;
- what is explicitly in scope;
- what is explicitly out of scope;
- the acceptance condition.

Do not expand the objective into adjacent cleanup or redesign.

## Phase 2 — Inspect verified current state

Start with the smallest focused read-only inspection that can answer the
planning questions.

Use the current-state precedence defined in the root `AGENTS.md`.

Inspect the canonical existing implementation before proposing a replacement.

For recovery or migration work, build a capability inventory before proposing
changes.

Classify relevant existing behavior as:

- KEEP
- REPAIR
- EXTEND
- REPLACE
- RETIRE

RETIRE requires explicit evidence that the behavior is obsolete, unsafe,
duplicated, or intentionally removed.

Uncertainty means inspect or preserve, not delete.

Never infer current runtime state solely from historical conversations.

## Phase 3 — Compare current state with intended architecture

Identify implementation drift explicitly.

For each material mismatch state:

- verified current behavior;
- intended architectural behavior;
- evidence for both;
- why the mismatch matters.

Do not reinterpret implementation drift as a new architectural decision.

If the architecture itself is genuinely insufficient or ambiguous, stop and
surface the architecture decision separately before implementation.

## Phase 4 — Reuse before adding

Before proposing any new:

- file;
- script;
- tool;
- skill;
- plugin;
- framework;
- policy;
- configuration entry;
- workflow;
- state store;
- scheduler;
- orchestration layer;

locate the existing canonical implementation and determine whether it should be
repaired, extended, or cleanly replaced.

Avoid parallel implementations and duplicate sources of truth.

## Capability and skill decision gate

Use the minimum capability set that produces the best engineering outcome.

Before adding a Codex skill, runtime skill, plugin, framework, or engineering
abstraction, establish:

1. what concrete capability or procedure is missing;
2. why existing model capability, `AGENTS.md`, `PLANS.md`, documentation,
   deterministic tooling, or an existing skill does not already satisfy it;
3. what measurable improvement the addition provides;
4. its context/token cost;
5. its permission and security impact;
6. its maintenance cost;
7. possible overlap or conflict with existing instructions or capabilities;
8. its exact loading/usage scope.

Add the capability only when its expected benefit materially exceeds those
costs.

Do not install an entire methodology or skill collection when only one narrow
capability is required.

Do not avoid a useful skill merely to minimize skill count.

For runtime domain agents, follow the architecture's stricter zero-runtime-skill
default and explicit approval requirements.

## Phase 5 — Choose the smallest correct solution

Prefer, in order:

1. repairing a clean canonical implementation;
2. extending it locally when the responsibility already belongs there;
3. cleanly replacing it when accumulated drift makes patching unsafe or
   confusing;
4. creating a new component only when no canonical existing owner fits.

Use deterministic code for mechanical, repeatable, stateful,
permission-sensitive, safety-sensitive, and externally observable operations.

Use LLM reasoning where semantic interpretation, ambiguity, planning, or
language reasoning is genuinely required.

Prefer native OpenClaw mechanisms before custom orchestration or another agent
framework.

Benson planning must not assume Git, branches, commits, or worktrees are
available. Use them only when the inspected workspace actually provides them.

## Phase 6 — Define the change set

For every planned implementation step specify:

- exact component or path;
- exact responsibility being changed;
- repair / extend / replace / retire decision;
- why the change is necessary;
- whether it changes runtime or durable state;
- dependencies on previous steps;
- what must remain unchanged.

Keep steps small enough that each can be independently validated.

Do not combine unrelated cleanup, formatting, migration, refactoring, and
behavior changes.

## Phase 7 — Backup and rollback

Before any destructive, state-changing, configuration-changing, or
structurally significant step, define a verified restorable checkpoint outside
active canonical directories.

For each relevant step identify:

- checkpoint contents;
- checkpoint location;
- how restoration would be performed;
- any durable side effect that cannot be reverted by file restoration alone.

Before retrying a state-changing operation, inspect whether the first attempt
already produced side effects.

## Phase 8 — Validation strategy

Validation must test the responsibility that changed.

Use the smallest sufficient validation ladder, for example:

1. syntax/schema/static validation;
2. focused deterministic/unit/contract test;
3. integration validation;
4. runtime health verification;
5. representative end-to-end behavior.

Not every change requires every layer, but meaningful architecture or runtime
changes require representative end-to-end acceptance.

For every planned change provide:

- validation command or procedure;
- expected result;
- failure/stop condition.

Never define success as merely "the command ran".

## Phase 9 — Acceptance

Define observable acceptance criteria before implementation.

Acceptance must verify the actual user/system behavior affected by the change.

For important agent workflows, verify the relevant path across:

`user request → Main decision → delegation → model → tools → verification → structured result → final response`

Do not claim success from configuration inspection alone when runtime behavior
is the objective.

## Phase 10 — Snapshot

After meaningful validated changes to Benson/OpenClaw configuration, agents,
workspaces, instructions, deterministic tools, models, delegation, permissions,
scheduling, domain state, or architecture:

1. run `bensonsnap`;
2. verify that a new snapshot was produced;
3. preserve/upload it as the new captured current-state source.

## Required plan output

A non-trivial Benson implementation plan should normally contain:

### Objective
What must be true when the work is complete.

### Verified current state
Only facts supported by current inspection or clearly identified snapshot
evidence.

### Intended state
The relevant architectural requirement.

### Implementation drift
Concrete differences between current and intended state.

### Capability preservation
Existing behavior that must remain working.

### Capability/tooling decision
Whether existing Codex/model/tools/skills are sufficient, and any justified
addition required for this task.

### Ordered implementation stages
For each stage:

- target;
- exact change;
- reason;
- checkpoint;
- validation;
- expected result;
- rollback when relevant;
- stop condition.

### Acceptance
Representative behavior proving that the objective is satisfied.

### Snapshot
Whether a new `bensonsnap` is required.

## Plan quality check

Before presenting a plan, verify that:

- it is grounded in inspected evidence;
- unknowns are marked as unknowns rather than guessed;
- it preserves valid existing capabilities;
- it follows ownership and responsibility boundaries;
- it uses the smallest correct change;
- it does not create parallel sources of truth;
- it does not introduce unnecessary skills, tools, frameworks, or abstractions;
- it also does not omit a capability that would materially improve correctness
  or efficiency;
- each state-changing step has appropriate backup and rollback;
- each step has measurable validation;
- acceptance tests the real workflow;
- the plan can be executed one measurable stage at a time.

If any of these are not true, improve the plan before implementation.
