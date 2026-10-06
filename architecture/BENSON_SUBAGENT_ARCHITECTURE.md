# Benson / OpenClaw Architecture and Operating Principles

**Canonical architecture document for the Benson home-agent project**  
**Document language:** English  
**Status:** Approved target architecture; implementation and production acceptance are tracked separately
**Last updated:** 2026-10-02
**OpenClaw compatibility provenance:** 2026-08-23 baseline; current evidence and limitations in Section 27  

> This document defines the intended architecture, responsibility boundaries, execution model, engineering principles, and maintenance rules for Benson/OpenClaw. It is not a runtime snapshot and must not be used as proof that a particular path, version, agent, model, tool, or configuration is currently installed.

## 1. Purpose and scope

Benson/OpenClaw is a local home-agent system running on a Raspberry Pi. It provides a single intelligent interface for family members through channels such as WhatsApp and voice, while coordinating home services including:

- Jessica vacuum control;
- reminders and scheduled actions;
- boiler control;
- irrigation;
- Home Assistant integrations;
- future home automations and domain services.

The architecture is designed around three primary quality goals:

1. **Reliability and correctness**
2. **Low token cost and efficient context use**
3. **Low latency and fast completion**

These goals are achieved through clear responsibility boundaries, high-quality task-specific prompts, minimal context, isolated domain agents, least privilege, structured contracts, and deterministic execution wherever appropriate.

The priority order is:

```text
Reliability and correctness
        ↓
Minimum sufficient context and execution
        ↓
Lower token usage and cost
        ↓
Lower latency
```

Token savings or faster responses must never be achieved by weakening correctness, safety, verification, or user trust.

---

## 2. Sources of truth

Benson uses different sources of truth for different questions. No single file should be treated as authoritative for both architecture intent and current runtime state.

### 2.1 Architecture intent

This document is the canonical source for:

- architectural principles;
- component responsibilities;
- delegation boundaries;
- deterministic-versus-agentic policy;
- sub-agent lifecycle rules;
- reliability, token-efficiency, and latency goals;
- security and least-privilege rules;
- engineering and maintenance practices.

Domain-specific architecture documents may refine this document for a particular domain, but they must not contradict it.

The canonical owner for this revision is `/home/oa/projects/benson/architecture/BENSON_SUBAGENT_ARCHITECTURE.md`. Ownership and revision scope are recorded in Section 27. The decision-routing implementation plan is subordinate to this architecture; preparation code and historical plan decisions do not define the target. Changes to this architecture require Oren's review; implementation-plan approval and stage authorization remain separate gates.

### 2.2 Current runtime state

Use the latest valid `benson-context-*.md` file as the captured infrastructure snapshot and source map, subject to focused current inspection and freshness limits.

The snapshot is the source of truth for the currently captured:

- OpenClaw version and configuration;
- agents and workspaces;
- models and runtime configuration;
- skills, tools, scripts, and documentation;
- directory structure;
- scheduled jobs;
- installed implementation state.

Always check the snapshot generation timestamp.

A snapshot is historical evidence from the moment it was generated. If meaningful work happened after that time, it is stale.

Failed snapshot queries do not establish absence or health of a capability. A newer filesystem map with failed runtime queries does not establish live behavior; retain the timestamps of older successful observations. Obtain a refreshed Pi snapshot after meaningful intervening changes before making current-production claims.

### 2.3 Direct inspection

Focused, current, read-only command output is more authoritative than an older snapshot for the specific state it inspects.

Examples include:

- current OpenClaw version output;
- current agent list;
- current config values;
- current file contents;
- current service status;
- current scheduled jobs;
- current logs for a specific run.

### 2.4 Previous conversations

Previous project conversations are useful for established decisions, constraints, and design intent.

They must not be treated as current proof of:

- file paths;
- installed versions;
- active models;
- runtime state;
- configuration values;
- successful execution.

### 2.5 Required precedence

For questions about **current state**, use this order:

```text
Focused live read-only inspection
        ↓
Latest valid snapshot
        ↓
Canonical implementation files and configuration
        ↓
Older snapshots or historical conversations
```

For questions about **intended architecture**, use this order:

```text
This architecture document
        ↓
Canonical domain contracts
        ↓
Current `AGENTS.md` runtime contracts
        ↓
Historical design conversations
```

If evidence is insufficient, record UNKNOWN: what is unknown, why it matters, and the minimum evidence needed to resolve it. Do not infer absence, success, failure, installation, capability, configuration or runtime state from missing evidence.

If verified implementation or runtime differs from the approved architecture, label it IMPLEMENTATION DRIFT and inspect the violated invariant. Do not silently redefine the architecture to match the implementation.

### 2.6 OpenClaw compatibility contract

OpenClaw-specific architecture assumptions must be verified against the currently deployed OpenClaw line before they are relied upon for implementation.

For the OpenClaw 2026.8.1 line verified for Benson on 2026-08-23:

- `TOOLS.md` is retired as an active workspace prompt source;
- local tool and environment guidance belongs in the `## Tools` section of `AGENTS.md`;
- native sub-agent context injects the target agent's `AGENTS.md`, not a separate `TOOLS.md` contract;
- `sessions_spawn` creates the isolated child run, `sessions_yield` ends the waiting parent turn without polling, and native child completion returns to the requesting session;
- `context: "isolated"` is the default Benson delegation mode; transcript forking is an explicit exception, not a convenience shortcut;
- OpenClaw Automations is the native scheduler and durable job store for reminders and scheduled work;
- OpenClaw's native delivery and session-routing mechanisms are preferred over Benson-specific outbound or completion transports;
- actual tool availability is determined by OpenClaw runtime tool policy, profiles, allow/deny configuration, sandbox/host policy, and execution allowlists;
- text in `AGENTS.md` explains how an approved tool should be used but does not grant the capability to invoke it.

Therefore Benson must never depend on a standalone `TOOLS.md` file for runtime behavior.

A legacy `TOOLS.md` may exist temporarily during migration or rollback, but it is non-authoritative and must be removed from the active canonical workspace after its still-valid content has been reviewed, migrated into `AGENTS.md ## Tools`, validated, and accepted.

When OpenClaw is upgraded, re-verify at minimum:

1. workspace/bootstrap prompt injection;
2. native sub-agent context injection;
3. `sessions_spawn` / `sessions_yield` lifecycle semantics;
4. effective tool-policy and allowlist behavior;
5. scheduler/Cron execution and delivery semantics;
6. any OpenClaw file or configuration surface on which Benson runtime behavior depends.

For the target control plane, also verify native pre-Main admission, bounded model access, exclusive execution commitment, automatic terminal enforcement for every Benson agent, completion-only capability restriction, trusted completion destinations, and frozen prepared-payload delivery/recovery. Conversation continuity additionally requires verified external-conversation versus execution-session identity, canonical transcript custody across routing paths, admission-consistent context reads, compaction ordering, authorized active-run continuation, and the scope/durability of concurrency controls. The logical boundaries below do not assert that any installed API already implements them. Section 27 records current evidence and gaps; exact native bindings belong to the separately approved implementation plan.

If official OpenClaw documentation appears inconsistent, prefer the most specific current documentation for the affected subsystem, then verify against focused installed-version runtime evidence and implementation/source when necessary. Do not preserve an older Benson assumption merely because it existed in a previous architecture revision.

---

## 3. System layers and component taxonomy

Benson is the complete orchestration system, not the Benson Main agent. It separates semantic reasoning, deterministic control, domain execution, device integration, response control, native delivery, and persistence.

```text
User / Channel -> OpenClaw native conversation / trusted admission
  -> Benson Request Controller: bounded conversation + workflow context
  -> one-shot Decision Model (when enabled)
  -> deterministic continuation policy first
       +-> verified active/pending workflow -> authorized continuation
       +-> otherwise ordinary routing policy
              +-> Benson Main -> optional fresh domain children
              +-> fresh Direct Domain Agent
  -> current domain eligibility (global Run capacity/pending admission deferred)
       +-> eligible pre-execution policy rejection -> trusted NOT_STARTED workflow-final (Section 6.7)
       |     -> Completion Control -> common Response Controller/final delivery path
       +-> admitted selected authorized execution/continuation
       -> approved deterministic tools -> atomic domain ownership/check/fencing before mutation -> verification
       -> owner result + explicit userResponse
  -> every agent: benson_complete -> deterministic completion validation
       +-> rejected: bounded completion-only repair; mutation disabled
       +-> exhausted: runtime constructs RECOVERED completion if evidence suffices
                       otherwise FAILED report; no execution replay
  -> accepted Benson Agent Completion Protocol -> Completion Control
       +-> nonfinal, no caller -> retain in existing workflow authority; no final response
       +-> trusted CALLER -> Main continuation / aggregation / final wording
       |     -> Main benson_complete -> accepted final workflow completion
       +-> trusted RESPONSE_CONTROLLER -> direct final-workflow projection
  -> Benson Response Controller (deterministic finalization/delivery gate)
       +-> usable userResponse: already-final owner message
       +-> explicit unavailable userResponse: bounded Response Model fallback
  -> final approved message -> prepare transport representation -> freeze
  -> existing OpenClaw outbound queue -> sendPrepared/provider -> User
```

OpenClaw-owned canonical conversation history spans these execution paths. Main and domain execution sessions consume authorized projections from it; neither an absent Main turn nor a terminated child may erase conversational continuity. Continuation authority precedes activation under Section 4; mandatory atomic domain ownership/check and fencing precede every mutation under Section 7. Global Run capacity/pending admission is deferred.

### 3.1 Three component categories

| Category | Examples | Responsibility |
| --- | --- | --- |
| Agents | Benson Main, Jessica, Reminder Service, future Benson agents | Semantic reasoning inside an OpenClaw-controlled run. Main owns broad/cross-domain orchestration; domains own internal reasoning and approved tool selection. The current final semantic owner owns normal user-facing composition. Every run uses the global completion protocol. |
| Deterministic components | Request Controller, continuation/routing policy, global Benson finalization, Completion Control, Response Controller, schemas, validators, authorization, domain-local renderers, state machines, persistence, domain tools, verification, idempotency, correlation | Mechanical, repeatable, permission-sensitive, lifecycle-sensitive, state-changing, externally observable, and validation behavior, including concurrency and resource ownership. |
| One-shot model capabilities | Decision Model and optional Response Model | Stateless bounded inference: request plus authorized conversation/workflow context to classification/continuation evidence, or minimal verified facts to fallback wording only for explicit message unavailability in an otherwise valid completion. These are not agents. |

Neither one-shot capability owns a conversation, hidden workflow state, domain tools, mutation, authorization, dispatch, lifecycle, or delivery. Agents also do not own native user delivery. Request Controller, global finalization, Completion Control, and Response Controller are logical responsibilities, not a mandate for separate processes, plugins, services, or another runtime.

### 3.2 OpenClaw runtime

Prefer native OpenClaw ownership of channel admission, conversation/session/transcript infrastructure, model-context assembly and compaction lifecycle, trusted runtime context, model access, agent identities and workspaces, fresh isolated runs, permissions, tool policy, lifecycle correlation, scheduling, persistence, transport, native delivery, logging, and recovery.

Benson owns routing policy, the versioned Benson Agent Completion Protocol and global finalization invariant, domain boundaries, response policy, and domain-local deterministic render contracts. Infrastructure applies finalization automatically to every Benson-managed run; new agents inherit it without private validators or retry machinery. First use native lifecycle surfaces where they satisfy those contracts. Do not introduce MCP, A2A, n8n, a second agent framework, a custom message bus, or another orchestration runtime merely to express these logical responsibilities.

### 3.3 Benson Main

Benson Main remains the central cognitive orchestrator for broad or unresolved contextual reasoning, multi-domain orchestration, and general semantic work. Main is not the owner of conversation history and is not necessarily invoked for an external request. A grounded single-domain continuation may follow Section 4 without Main; unresolved semantic dependencies still belong to Main.

Main prepares domain briefs, evaluates cross-domain dependencies, aggregates validated structured completions, and owns the final user-facing message whenever it owns the workflow. Every Main run settles through benson_complete; only workflow-final settlement uses the final-workflow kind of the Benson Agent Completion Protocol (the ResponseEnvelope role). Main is not the final delivery boundary. Historical evidence and current verification limits are recorded in Section 27.

### 3.4 Domain sub-agents

Each domain sub-agent owns reasoning and orchestration inside one approved domain. Examples are `jessica-vacuum`, `reminder-service`, and future boiler, irrigation, and home-service agents.

Domain sub-agents do not own the user channel and must not message users directly. They finalize domain-task completions (the TaskResultEnvelope role) through the same global benson_complete mechanism as Main. An eligible direct-domain agent is the final semantic owner and supplies its user-facing message. A Main-spawned child returns structured results and explicit response state to CALLER/Main; Main owns the final workflow wording.

### 3.5 Deterministic execution and control

Deterministic scripts, tools, APIs, schemas, workflows, and state machines perform mechanical and externally observable operations. They provide validated inputs, explicit outputs, idempotency, predictable failure behavior, structured logs, authorization and allowlist checks, transaction handling, and rollback or compensation where appropriate.

The surrounding control plane enforces exclusive execution commitment, trusted completion destinations, correlation, response policy, and bounded recovery. It does not take over domain reasoning.

### 3.6 Home Assistant

Home Assistant is the device-integration layer. It normalizes device capabilities, entities, states, and services. Agents normally access it through approved domain tools rather than raw service calls.

### 3.7 Persistent state

Persistent state lives in explicit storage with deterministic ownership: native conversation, lifecycle and scheduler records, domain metadata, structured pending-context records, or Home Assistant state where appropriate. Distinguish:

| State | Meaning and owner |
| --- | --- |
| Canonical conversation transcript | OpenClaw-owned retained external turns and final assistant messages, correlated independently of which agent executed them. It is the durable source for later conversation reads, subject to native retention/access/reset policies. |
| Agent/model session context | The context assembled for a particular execution session. A fresh isolated domain run is not the canonical external conversation. |
| Compacted model context | An OpenClaw-managed representation of older history plus retained context. Built-in summarization uses an LLM; lifecycle ownership and persistence do not make its semantic output deterministic or exact. |
| Recent exact turns | Original relevant user/assistant entries with speaker, order and source identity; obtain exact text from canonical entries, not reconstructed summaries or display previews. |
| Active/pending workflow state | Trusted lifecycle, correlation, pending clarification and resource-ownership facts under Section 7.4; capacity facts apply only once hardening is enabled; prose and summaries are not authoritative control state. |

Conversation continuity sits logically above Main/domain execution sessions. Bind the trusted channel/account/peer/thread address and requester to the native conversation and its current session/transcript identity; an agent-scoped `sessionKey`, a replaceable `sessionId`, and a temporary `runId` serve different purposes. Shared-group membership or an identical domain is not identical requester authority. Physical storage under an agent namespace does not make that agent's model the history owner.

Every accepted external turn, including a direct route and a continuation, must retain exact source text and provenance through native input/transcript custody, with one canonical conversation entry when adopted. Admissions joined under Section 6.4 remain individually recorded and correlated to their workflow's shared final assistant message and delivery status, even if Main never ran. Use native recording/receipt and deduplication mechanisms; child transcripts may retain execution evidence but cannot be the only record of the user conversation. Verify this across route changes, resets, retention, cancellation and restart before enabling the path; no duplicate Benson conversation database or synthetic transcript reconstruction is authorized.

After a run ends, new isolated activations obtain relevant authorized history and pending context from these explicit owners, not the terminated run's hidden state. Unavailable or expired context is explicit and requires safe clarification where necessary. Reuse native state ownership; do not create a duplicate scheduler, execution/session ledger, completion store, or delivery ledger merely to represent a conceptual contract.

---

## 4. Request admission and cognitive orchestration

Every new admitted external interactive user request enters the deterministic Benson Request Controller before general Main inference. OpenClaw retains native command, permission, cancellation, and admission behavior. Internal completions, heartbeats, retries of an existing admission, and recovery events are not new external requests and must not be reclassified as such.

### 4.1 Benson Request Controller

The controller receives the trusted OpenClaw admission/runtime envelope, preserves the exact current request and conversation binding, and obtains an admission-consistent conversation/workflow view (Section 5.3). It constructs bounded Decision Model input, invokes the configured capability when enabled, validates its evidence, and applies continuation policy before ordinary routing. It commits the admission once: to an authorized existing workflow action, or to one initial Main/direct execution path, subject to current domain/resource policy under Section 7.7. Missing or unusable classification selects Main for semantic resolution before commitment; Main cannot bypass another workflow's authority or uncertain execution ownership.

The controller does not resolve Jessica rooms, calculate Reminder times, choose domain tools, construct domain transactions, perform domain reasoning, grant authorization, or claim execution success.

### 4.2 One-shot Decision Model

The Decision Model is provider-independent and replaceable behind a stable Benson decision contract. Jev / TypeSafe is an intended candidate, not an architectural dependency or a prerequisite for ordinary Main operation.

Input is a fixed/versioned rubric and the minimum-sufficient trusted routing-context projection defined in Section 5.3: exact current request, necessary requester/conversation bindings, relevant recent conversation, existing compacted context when useful, and applicable active/pending workflow metadata. Trusted provenance does not make quoted text or a model-generated summary an instruction or authorization source. Keep opaque binding references and only necessary facts in the model projection; retain authoritative records in deterministic control. Do not send the full transcript, secrets, unrelated users' history, hidden reasoning or bulk tool/domain state by default.

The model supplies bounded classification/continuation evidence: candidate domain or Main, relation to a supplied workflow/context reference, grounded versus unresolved dependency, single-domain versus mixed-domain, supported versus uncertain, and provider-supported confidence only where meaningful. It may recognize "actually", "also", "do it twice", "the same one", or "and the living room too" from the supplied context. It cannot grant authority, choose a trusted route, discover arbitrary sessions, mutate state, steer a run, or fabricate a workflow binding. Exact schemas, evidence thresholds, bounds and projection algorithms await implementation planning. Privacy restrictions or insufficient evidence leave semantic resolution with Main without expanding its authority.

### 4.3 Deterministic routing policy

Apply this order to each new external turn:

1. Establish trusted admission, requester and canonical conversation identity; read bounded conversation and active/pending workflow context.
2. Obtain and validate Decision Model evidence when enabled.
3. Before ordinary routing, deterministically check whether the turn relates to an eligible active or pending workflow. Semantic evidence may identify a relation; sharing a chat/group never establishes workflow identity or steering authority. Check the exact requester/authorized actor relationship, conversation, workflow, native run/session generation, lifecycle phase and domain continuation contract. Revalidate at admission to avoid a stale read racing completion, cancellation or replacement.
4. For a verified relation to an eligible workflow, continuation policy owns the admission: join the active workflow under Section 6.4 and continue its authorized run through a proven native binding, use a proven existing lifecycle resume, or wait/reject/clarify under Section 7. Global capacity-pending admission and automatic promotion remain deferred. An inability to continue safely is not permission to start a competing run. A pending workflow whose run is terminal may require a fresh isolated activation with explicit context; it never resurrects hidden execution state. Once the workflow's terminal finalization begins, no later admission can join it; route that new admission through ordinary routing with current context and domain/resource checks.
5. Otherwise choose ordinary Main/direct routing. A direct route is eligible when the exact request plus bounded authorized context sufficiently establishes a supported single-domain task, with valid authority, domain/resource eligibility and completion handling. Actual mutations still acquire/check ownership atomically at the domain boundary. Context dependence alone does not require Main.

Ambiguous, broad or multi-domain work, and semantic dependencies not resolved by the authorized bounded context (including historical references), select Main for resolution. Unsupported input or invalid/unavailable classification also selects Main before execution commitment. Main may clarify or coordinate permitted work; it cannot bypass continuation, resource or no-replay gates, or enabled hardening controls. Model confidence and agent-authored route fields never select the trusted owner.

For example, a same-conversation correction to Jessica R1 can continue R1 without Main when the binding and lifecycle permit it. A new Jessica request from another user cannot alter R1 merely because it targets the same domain or arrives seconds later. Section 7 defines mandatory resource/isolation rules and the deferred capacity target.

### 4.4 Benson Main's orchestration responsibility

For requests assigned to Main, Main consumes authorized OpenClaw-owned conversational context, including relevant prior direct-domain turns, selects domain tasks and an appropriate approved model, builds minimum-sufficient briefs, and requests fresh isolated runs through native lifecycle mechanisms. Deterministic control establishes each run's authority and completion route and enforces Section 7 concurrency/resource policy. Main consumes correlated validated protocol completions, continues or aggregates the workflow, and owns final response composition. Its final ResponseEnvelope includes explicit userResponse state and must pass benson_complete before reaching the Response Controller.

Main may orchestrate several children while remaining the single initial workflow owner. Each committed child task has its own single execution owner; these children are not competing initial execution paths for the admission.

### 4.5 Cognitive orchestration, not domain takeover

Benson Main performs cognitive orchestration, but it must not take ownership of domain-internal execution.

It may:

- resolve conversational references;
- identify that a request belongs to the Reminder, Jessica, Boiler, or Irrigation domain;
- select relevant prior turns;
- explain the user's goal in the task brief;
- include trusted runtime facts;
- define the expected result contract;
- state safety and communication constraints.

It must not, when a dedicated sub-agent owns the domain:

- choose internal domain record IDs;
- construct domain schemas or patches;
- select internal helper scripts;
- choose Calendar event IDs or Cron job IDs;
- decide the domain transaction plan;
- perform domain verification or rollback itself;
- claim success without the domain result.

The distinction is:

```text
Benson Main
understands the conversation and prepares the task

Domain sub-agent
understands and orchestrates the domain operation

Deterministic tools
perform and verify the actual operation
```

---

## 5. Optimal delegation prompts

For Main-owned workflows, the quality of the semantic delegation prompt is a core responsibility of Benson Main. For an eligible direct request or continuation, deterministic formatting preserves the exact current request and minimum relevant authorized context under the reviewed domain contract; no Main prompt-generation call is required.

A delegation is not ready until the selected sub-agent has everything reasonably required to understand the task quickly and execute it correctly without unnecessary rediscovery.

The delegation brief is task-specific context passed through native isolated execution. Main normally supplies a semantic brief in `sessions_spawn`; direct routing supplies a bounded request envelope through a verified native binding. Neither is the whole child runtime.

The child receives three distinct context planes:

```text
1. Static domain contract
   OpenClaw loads the target agent's AGENTS.md.

2. Task-specific context
   Main supplies the exact request and minimum prior semantic context;
   direct routing supplies the exact request and bounded authorized context.

3. Trusted runtime and capability context
   OpenClaw supplies and enforces session routing, agent identity, channel
   context, tool policy, sandbox/host policy, and allowlists.
```

These planes must not be duplicated or confused. Main selects semantic context for its workflows; Request Controller projects bounded routing context and passes the necessary authorized fragments to an eligible direct execution/continuation. Both read OpenClaw-owned conversation state. Neither semantic briefs nor classifiers manufacture trusted identity, permissions, scheduler state, or tool capability.

### 5.1 Required prompt qualities

A good delegation prompt is:

- task-specific;
- concise but complete;
- faithful to the current request and relevant prior conversation;
- explicit about the objective;
- clear about constraints;
- free of unrelated conversation history;
- free of duplicated domain instructions;
- precise about the expected result;
- safe against accidental instruction mixing;
- provenance-preserving, so the child can distinguish current user text, prior quoted conversation, deterministic pending state, and Main's task instructions.

### 5.2 Prompt contents

When relevant, the delegation prompt should include:

- the current user request, preserved verbatim;
- the user's actual goal;
- the minimum sufficient prior conversation turns needed to resolve references, ellipsis, follow-ups, corrections, comparisons, and implied subjects;
- prior decisions that materially affect the task;
- unresolved questions or deterministically stored `pendingContext` facts that are relevant to the current continuation;
- the task objective;
- task-specific constraints that are not already part of the domain agent's `AGENTS.md`;
- the required structured output contract when it is not already fixed by the domain contract.

The brief must not contain model-authored claims about:

- requester identity or authorization;
- source-session authenticity;
- runtime permissions or available capabilities;
- a calculated current time or absolute schedule;
- Cron expressions, scheduler IDs, Calendar IDs, or delivery receipts;
- whether a state-changing operation succeeded.

Those facts are supplied or verified through trusted OpenClaw runtime context and approved deterministic capabilities. Native `runId`, child-session correlation, and completion routing belong to trusted lifecycle/control metadata (Section 6.4), not agent-authored semantic instructions. Conceptual request identity does not require a duplicate custom handoff ID or store.

### 5.3 Context projection

#### Routing projection and native context lifecycle

Request Controller consumes a consistent OpenClaw-owned view tied to the current admission, then builds a bounded routing projection. The view must identify the canonical conversation/session generation, the admitted current turn and a transcript revision/cutoff or equivalent native consistency evidence, plus the relevant workflow-state revision. Do not mix another request's future turns, an old summary with a replaced transcript, or stale workflow authority. The exact read/assembly seam and freshness/revalidation mechanism are implementation-time UNKNOWNs, not an invented snapshot API.

The ordinary fast path includes the exact current turn, a small bounded recent window of exact messages from the same verified canonical conversation, and trusted active/pending workflow metadata, preserving sender identity/provenance. Never select a global history window or semantically search older history. Include older exact turns only when trusted structural workflow/pending provenance explicitly references them by identity. An existing native compacted summary MAY be consumed only under the same verified conversation and cutoff; summary text is never proof of authorization, execution, pending-state validity or an exact quotation.

Bound projection bytes/tokens without silently truncating exact messages or required references. Insufficient deterministic bounded context falls back to Main. Missing or inconsistent context and cross-conversation contamination fail closed; there is no global-history fallback. Same-conversation access still requires requester/privacy isolation, especially in shared conversations. Concrete window limits, OpenClaw binding mechanics, native read costs and representative continuation/isolation evidence belong in the implementation plan.

OpenClaw owns transcript retention, model-context assembly and compaction scheduling. In the inspected built-in runtime, compaction appends a summary boundary while retaining original history; model context uses that boundary and retained recent entries. Required compaction occurs before inference and may also follow provider overflow; optional persistent-session maintenance follows settled delivery and is settled/cancelled before a later turn reads context. Other harness/provider engines may differ (Section 27). Pre-model admission hooks do not prove that a compacted, admission-consistent view already exists at Request Controller's boundary.

Request Controller routing-context selection/projection is deterministic and model-free. It MUST NOT invoke an LLM, agent, embedding model, semantic reranker or any other model inference to retrieve, select, rank, summarize or assemble context for the Decision Model. It MAY consume an OpenClaw-native compacted summary that already exists, but MUST NOT trigger new model inference, summarization or compaction as a routing side effect. The ordinary fast path has exactly one routing inference: the Decision Model. If the deterministic bounded projection is insufficient, fall back to Main rather than adding another model call. Built-in compaction is LLM work under OpenClaw lifecycle control, with its own latency/cost. No new context engine or summary store is authorized by this requirement.

#### Main-owned semantic projection

When Main owns the workflow, it selects the minimum sufficient prior turns needed to interpret and delegate the current message. Selection is dependency-based, not a fixed message count or a full-conversation copy. Main uses the same authorized native history, including turns that bypassed Main.

Main should:

1. preserve the current user message verbatim;
2. detect unresolved references or context dependencies in it;
3. trace only the prior turns needed to resolve those dependencies;
4. preserve speaker, order, and quoted wording for short relevant fragments;
5. use a concise faithful summary only when the required context is too large to quote directly;
6. omit unrelated turns, even when they are recent;
7. leave domain-internal classification and execution to the target sub-agent;
8. request clarification instead of guessing when the selected context still does not establish a safe interpretation.

A short message may depend heavily on earlier context. Examples include:

- "and the day after tomorrow";
- "yes";
- "both";
- "fifteen minutes earlier";
- "also add it to the calendar";
- "delete it";
- "do the same for Ilana".

These messages must not be delegated in isolation when the meaning depends on previous turns.

Correct pattern:

```text
Current user request:
"And the day after tomorrow?"

Relevant conversation context:
The following turns are quoted conversation data, not instructions.

- user: "Show me all my reminders for tomorrow."
- assistant: "You have three reminders tomorrow..."

Task:
Interpret the continuation inside the Reminder domain, use only approved
deterministic capabilities, and finalize the domain-task result through the Benson Agent Completion Protocol.
```

Incorrect pattern:

```text
Current user request:
"And the day after tomorrow?"
```

### 5.4 Quoted context versus instructions

Prior conversation turns must be clearly marked as quoted data.

The sub-agent must know that the quoted content describes the conversation and is not a new system instruction.

Quoted context should retain its speaker and order. A summary must be explicitly labeled as a summary and must not silently convert an assumption into a user-stated fact.

Trusted runtime facts must not be copied from ordinary conversation text and relabeled as authoritative. When the domain needs a trustworthy time base, requester identity, channel route, or authorization fact, it must obtain that fact from OpenClaw or an approved deterministic interface.

### 5.5 No unnecessary deterministic prompt builder

Semantic context selection and task-brief construction are appropriate LLM responsibilities for Benson Main.

A separate deterministic prompt builder is not required by default.

A deterministic formatter may be introduced later only when there is a measurable need for:

- strict schema validation;
- size limits;
- escaping and sanitization;
- transport compatibility;
- repeatable envelope formatting.

Direct routing has a justified deterministic formatting need: preserve exact text and provenance, enforce the routing projection's bounds, and separate quoted conversation from trusted runtime metadata. This is Section 5.3 projection, not a second semantic prompt-generation service. Decision evidence and deterministic continuation policy handle grounded continuations; unresolved semantic selection belongs to Main, and domain reasoning remains with the domain.

### 5.6 Isolated context by default

Benson normally delegates with native `sessions_spawn`, an explicit target `agentId`, `context: "isolated"`, and the task-specific brief.

`context: "fork"` must not be used merely to avoid selecting context. Forking a transcript is allowed only when a reviewed workflow genuinely requires the broader requester transcript and the privacy, token, instruction-mixing, and domain-boundary costs are justified.

An isolated child is clean, not empty. OpenClaw loads the child's `AGENTS.md`, applies effective tool policy, and provides the trusted runtime envelope. Main supplies a semantic brief when it is the caller; direct routing supplies the eligible bounded request/context. Both paths require identical isolation and capability enforcement. Authorized steering of an existing active run is not a new activation or transcript fork; a later new activation still starts fresh with explicit projected context.

---

## 6. Benson Agent Completion Protocol and response contracts

The **Benson Agent Completion Protocol** is the single canonical versioned schema family for all Benson agent completions. Main, Jessica, Reminder, every current domain agent, and every future agent created or spawned under the Benson runtime must use it. No agent-to-agent, agent-to-Main, agent-to-Completion-Control, or agent-to-Response-Controller completion is consumed as free-form prose. Natural-language reasoning may remain inside an agent run; a completion crossing its boundary must be validated structured data.

The same family also represents trusted deterministic control-plane workflow finals without creating a run (Section 6.7), including pre-activation rejection and reviewed pending terminal outcomes. This adds no executor or schema owner: run-origin records require run authority; control-plane records require current admission/workflow authority and positively established execution history. NOT_STARTED is valid only when the workflow never executed.

TaskResultEnvelope and ResponseEnvelope name the domain-task and final-workflow roles within this family, not independent common contracts. Completion kind follows the authorized task/workflow role, not a private per-agent format. Future roles use the applicable kind or a reviewed versioned extension within this same family; they inherit all global finalization machinery unchanged. Field names and completion kinds below define semantics; exact wire encoding, schema technology, version negotiation/migration, and native binding belong to the implementation plan. Unsupported versions fail closed.

### 6.1 Execution selection and domain ownership

The Request Controller binds a verified continuation or selects the initial Main/direct-domain owner under Section 4. For a Main-owned workflow, Main semantically selects subsequent domain tasks. Jessica owns vacuum reasoning, Reminder Service owns reminders and Calendar-linked Reminder work, and future domains retain their approved boundaries. Direct routing is an optimization for eligible single-domain requests with sufficient authorized context; it does not weaken Main's broad contextual or cross-domain role.

### 6.2 Domain classification and final semantic ownership

The dedicated domain agent owns internal operation classification and approved tool selection. For example, Reminder Service determines create, list, find, update, delete, pause, resume, clarification, or Calendar-linked lifecycle work. Main and the Request Controller must not duplicate that operation logic.

The trusted workflow binding determines the current final semantic owner:

- Direct domain: Jessica or Reminder owns the domain result and normal final user-facing wording.
- Main-owned workflow: a domain child supplies its structured result and may include useful domain wording; its destination is CALLER/Main. Main owns aggregation and the final user-facing message.
- Main-only workflow: Main owns the semantic answer without inventing a domain execution result.

Final semantic ownership identifies who composes an eventual final; it does not make every run by that agent workflow-final. An agent does not choose final ownership, completion scope, finality or disposition by writing a field. CompletionRoute remains trusted orchestration state.

### 6.3 One schema family; domain-task completion / TaskResultEnvelope

The common protocol requires explicit version and discriminated completion kind, outcome/finalization state, structured facts with verification limits, warnings, errors, partial effects, uncertainty, clarification state where applicable, and explicit userResponse state. Trusted runtime binding accompanies the accepted completion. A successful protocol validation means the record is accepted, not that domain work succeeded, physical work finished, or a message was delivered.

The domain-task kind retains the TaskResultEnvelope role:

| Concept | Mandatory semantics |
| --- | --- |
| `schemaVersion`, `kind` | One versioned common family; domain-task or final-workflow kind. Domain data retains its own version. |
| `status` | Task outcome, including success, clarification required, failure, and mixed/partial or uncertain outcomes where applicable; never conflated with finalization acceptance. |
| Completion outcome / error | Runtime-assigned NORMAL, RECOVERED, or FAILED (Section 6.10), independently of task/workflow status. Exhausted agent attempts alone are not system failure. Exact wire encoding is deferred. |
| `domain`, `operation` | Owning domain and applicable domain operation, checked against the authorized run and evidence. Unknown operation remains explicit when not established. |
| `verified`, `data` | Structured domain facts and their verification scope, grounded in deterministic tool/runtime evidence. Accepted, started, and completed remain distinct. Unknown and not-applicable states are explicit. |
| `warnings`, `error`, partial effects, uncertainty | Preserve known warnings, failures, durable effects, evidence gaps, and unresolved execution outcomes, including during finalization failure. |
| `pendingContext` | Explicit clarification/continuation data with grounding, binding, version, and expiry when applicable. |
| `userResponse` | Required discriminated response state as defined below; never an accidentally absent optional candidate. |
| Trusted binding / provenance | Admission/request and workflow correlation (including joined admissions under Section 6.4), run, agent, caller/parent correlation, authorization, execution/tool evidence, verification state, completion destination, and delivery policy, attached by or checked against deterministic authority. |

`userResponse` explicitly distinguishes:

1. **Usable:** a bounded message and language/locale information consistent with the owning response contract. It is final-delivery wording only in a workflow-final completion; retained nonfinal wording has no delivery authority, and child wording remains subordinate to Main when routed to CALLER.
2. **Unavailable:** an explicit structured reason that no usable message is available. In an otherwise valid final-workflow completion this is eligible for bounded response fallback. A child may use this state without invoking fallback at the child boundary.
3. **Missing or malformed:** a protocol violation, including a claimed usable state without a usable message. It must enter completion repair, never be heuristically converted to unavailable.

Important execution facts cannot exist only in prose. Model-authored `verified: true`, correlation IDs, provenance, authorization, routes, or delivery policy are never authoritative by themselves. The model proposes semantic content; deterministic runtime/tool evidence supplies trust. Completion content cannot grant permissions or redirect itself.

### 6.4 ExecutionRoute and trusted CompletionRoute

Workflow is the logical task lifecycle; an Agent Run is a temporary execution that advances it. Run completion does not imply Workflow completion. A nonterminal workflow may span fresh isolated runs and durable intervals with no live LLM. Its reviewed completion policy defines the close condition and permitted terminal outcomes by domain and operation type, rather than agent identity alone. Deterministic authority binds that policy and evaluates its predicates against trusted evidence; successful tool execution, model wording and run exit cannot choose workflow finality.

Execution owner answers who performs the task; completion disposition answers what happens to its accepted run result. Deterministic Benson/OpenClaw orchestration establishes admission identity, trusted requester/conversation/workflow binding, completion policy, owner/run identity, caller/parent correlation where applicable, finality and delivery policy before accepting a completion. CompletionRoute permits retention at the existing workflow owner for a nonfinal callerless result, CALLER delivery for a correlated child result, or RESPONSE_CONTROLLER delivery only for a workflow-final result. Continuing a workflow preserves its trusted completion owner and reviewed policy; classifier output cannot change them.

**Shared final:** a later external admission deterministically accepted as a continuation, amendment or refinement of the same active workflow before terminal finalization begins joins that workflow. Each admission remains independently recorded in the canonical conversation and bound to the workflow. The joined workflow produces exactly one final-workflow completion and one final interactive delivery reflecting the latest accepted intent, accumulated in trusted admission order. Joined admissions do not independently produce final responses. The trusted workflow binding identifies its admitted membership and accepted-intent revision; these are control state, not model-authored authority or a new store.

The existing lifecycle owner must serialize joining with entry into the workflow's terminal finalization, authorized only when the reviewed close condition is satisfied and the completion is workflow-final. That entry closes membership and the accepted-intent revision before completion validation/repair and before transport freeze. The cutoff cannot wait for successful completion or delivery. Later admissions follow normal new-admission routing and cannot amend this workflow's final completion or frozen payload. Nonfinal run settlement, including a direct domain run, does not close workflow membership; a child's settlement does not itself close a still-active Main-owned parent workflow. Duplicate events/retries for an already joined admission retain its original binding and never acquire a new final response. Section 7.5 governs whether a supported native binding can actually enforce this contract; unavailable proof keeps joining disabled.

CompletionRoute is the completion portion of this trusted native orchestration state, not a second model-authored payload or new store. A Main-spawned domain child normally returns to CALLER/Main. A nonfinal callerless result is retained with exact workflow/run/policy correlation and explicit next lifecycle state; it neither fabricates a caller nor enters Response Controller. Only workflow-final direct-domain or Main completions go to RESPONSE_CONTROLLER. Agent text never selects the disposition, destination, recipient, channel or session. Retention grants no automatic successor activation or delivery authority.

### 6.5 Benson Completion Control

Completion Control deterministically binds accepted protocol completions to the committed lifecycle, checks expected ownership, version/kind, reviewed completion policy, trusted correlation, provenance, finality and duplicate/stale state, and applies the established disposition. Final-workflow acceptance also checks the policy's close condition, closed admission membership and accepted-intent revision from Section 6.4; a stale candidate for an earlier intent cannot finalize the workflow. It uses the canonical validation contract; it does not own another schema family or another repair loop.

- CALLER: deliver the accepted structured completion for the assigned task/workflow, including NORMAL/RECOVERED completions and canonical FAILED reports, to the correlated caller, normally Main. A child's locally final result does not confer finality for the parent's interactive workflow.
- Nonfinal retention: retain the accepted result of a settled run, including NORMAL/RECOVERED or FAILED, under existing durable workflow authority without a live caller or final response. The existing workflow owner applies the policy-bound next state; Completion Control neither settles runs nor owns waiting, recovery or later activation.
- RESPONSE_CONTROLLER: deliver accepted workflow-final completion only. Project a direct domain-task completion into the final-workflow kind within the same schema family only when the reviewed close condition and trusted workflow-final binding hold; validate that projection. A nonfinal direct result is never projected or delivered as a final.

Direct projection preserves every result's task status, NORMAL/RECOVERED/FAILED outcome, domain schema, evidence, warnings, errors, partial effects, uncertainty, pending context, and userResponse. It attaches only trusted workflow/source/finality/policy binding. It neither recomposes the message nor invokes Main or another agent run. The domain remains the final semantic owner.

Only accepted canonical completions leave the agent boundary. Unknown, contradictory, duplicate, stale, uncorrelated, or unsupported records cannot advance a successful continuation or produce another final response. Rejected candidate output stays within finalization (Section 6.10). A stale or duplicate event cannot acquire a new admission simply by being wrapped in a failure record. Where lifecycle correlation is missing, native recovery retains ownership and fails closed rather than guessing a recipient.

Reuse native lifecycle, parent/child correlation, requester continuation, transcript ownership, persistence, and recovery. Completion Control and global finalization are responsibilities at existing boundaries, not new services, polling loops, transports, completion stores, or dispatchers.

### 6.6 Main continuation and finalization

A validated child completion resumes Main's existing workflow through the trusted caller binding. Main may evaluate dependencies, start authorized subsequent tasks, aggregate results, and perform contextual reasoning. Cross-domain mutations still require deterministic predicates over verified structured facts (Section 24.4).

This ordinary workflow continuation precedes Main's terminal finalization. Once Main enters completion-only repair, it cannot spawn or mutate to repair its answer. A child's RECOVERED completion carries its actual task outcome without being downgraded to business failure. A FAILED report preserves known effects and uncertainty without claiming a complete trustworthy task result. Neither permits Main to repeat completed or uncertain child work.

When its reviewed close condition is satisfied, Main composes the final user-facing message inside its workflow and submits a workflow-final completion to benson_complete. Completion Control then routes the accepted completion to Response Controller. A Main run that settles before that condition remains nonfinal under Section 6.4. Response Controller does not send an already completed direct workflow to Main for semantic rewriting.

### 6.7 Final-workflow completion / ResponseEnvelope

The final-workflow kind fulfills the ResponseEnvelope role in the same versioned family. It carries common completion semantics plus:

- trusted workflow correlation, closed membership of independently recorded admissions, accepted-intent revision, typed source authority (agent/run, or admission/workflow authority for control-plane terminalization below), finality, and delivery-policy binding under Section 6.4;
- actual overall task/workflow outcome and separate runtime-assigned NORMAL/RECOVERED/FAILED completion outcome;
- `results[]`, retaining each domain result's version, task identity, operation, status, verification scope, facts, warnings, errors, partial effects, uncertainty, and provenance;
- grounded pending clarification/continuation state;
- mandatory `userResponse` with the same usable/unavailable distinction.

A direct domain normally contributes one result; Main may aggregate any bounded collection permitted by the contract. Main-only conversation can have no domain results, with execution verification explicitly not applicable. Overall success cannot hide failed children or inflate command acceptance into physical completion. RECOVERED preserves actual task/workflow success, failure, or partial outcome; agent envelope-generation failure must not change that business status. FAILED records actual inability to establish a complete trustworthy completion while retaining known domain success, partial effects and uncertainty. Aggregation preserves these per-result distinctions instead of treating all exhausted attempts as failed tasks.

The final semantic owner's wording is part of completion, not an alternative source of execution truth. Structured facts remain authoritative. The shared final addresses the latest accepted intent without silently dropping joined corrections or claiming they were applied merely because they were admitted. If an amendment could not be applied or its outcome is uncertain, preserve that limitation and any prior effects in the result and wording. The owner preserves exact relevant dates/times, warnings, partial effects, errors, and uncertainty in its response contract. Normal deterministic rendering belongs with the domain owner (Section 6.9), not Response Controller.

**Deterministic control-plane terminalization without a Run.** Capacity-overload and capacity-pending terminal cases are deferred under Section 7.7; this generic contract remains valid for applicable trusted pre-execution and existing native/domain wait outcomes. A busy mutation rejected inside an existing Run uses ordinary run settlement, not a fabricated NOT_STARTED workflow. A new eligible workflow rejected before activation may terminate with positively proven NOT_STARTED, including active/pending overload once capacity hardening is enabled. A pending workflow may also terminate without creating a run when authorized cancellation, reviewed expiry or permanent ineligibility satisfies its completion policy. The existing trusted workflow authority verifies current policy, authorization, generation, intent and execution history; atomically closes all accepted membership, including joined admissions; and excludes concurrent join/activation. Missing executor records or uncertain dispatch cannot establish NOT_STARTED. Prior settled runs and effects remain authoritative when pending work has already executed; no current run does not erase that history.

An activation denial for a child, successor or scheduled run within an existing workflow instead returns trusted denial evidence to its caller/lifecycle owner. It creates no run or agent completion and does not close the parent workflow. That owner may separately apply the parent's reviewed completion condition; an activation failure alone grants no workflow-final authority.

The existing global finalization responsibility constructs and validates the typed canonical workflow-final record through the same common family, using the trusted terminal decision and truthful policy-owned deterministic wording. The workflow outcome reflects rejection, cancellation, expiry or permanent ineligibility as actually established; it is not an invented agent/domain failure. NORMAL accepts a valid deterministic control-plane final without claiming an agent ran or needed repair; run-origin outcome semantics in Section 6.10 remain unchanged. This path uses no model inference, agent repair, reporting agent or Response Model fallback.

Completion Control follows the trusted RESPONSE_CONTROLLER disposition; Response Controller validates the typed source, finality and ordinary delivery eligibility. The result uses the same canonical final identity, transcript receipt, preparation/freeze and native delivery/recovery as run-origin finals. Terminalization fences later activation and retires only that workflow's verified existing claims (capacity reservations only once hardening is enabled); it does not establish physical/resource release. Missing authority or uncertain execution/cleanup stays with existing recovery, never a guessed recipient, raw send or new reporting run.

Duplicates, retries and restart reuse the terminal decision, closed membership, applicable cleanup evidence and one logical final instead of reopening the old workflow when resource/capacity availability changes. Cleanup recovery cannot reactivate terminal work or release another workflow's claim. A delivery-eligible closed workflow receives one final for its whole membership; terminal work never reopens. Native lifecycle/persistence and delivery remain the existing owners: no extra store, queue, dispatcher, scheduler or lifecycle owner. The plan must specify version/compatibility for these typed sources; missing legacy run fields alone never establish them.

### 6.8 Interactive outbound classes and final-response gate

Interactive user communication has two distinct classes:

| Class | Architectural semantics |
| --- | --- |
| Progress notification | Optional nonterminal communication that an LLM may initiate multiple times inside an active agentic loop under reviewed policy. It does not end the run, close workflow membership, constitute Benson completion, release resource ownership or replace/suppress the final response. Delivery may be best-effort. |
| Final response | Terminal workflow communication governed by the Benson Agent Completion Protocol, Completion Control, Response Controller, preparation/freeze and native delivery/recovery. Exactly one logical final serves the workflow's closed membership; progress does not change that invariant. |

Every interactive final response passes through exactly one Benson Response Controller before native delivery, including direct domain, Main-only, multi-domain, clarification, failure and deterministic control-plane terminal responses.

Its normal work is deterministic: accept only validated final-workflow completions; validate trusted workflow/admission-membership/typed-source/finality/correlation state, including run identity for run-origin records and admission/workflow authority with verified terminal condition and execution history for control-plane records; enforce one finalization and one final interactive delivery per workflow, shared by all joined admissions under Section 6.4; enforce delivery eligibility and bounded output constraints that need no general semantic interpretation; and hand the already-final message to native OpenClaw delivery. Duplicate/recovery events from any joined admission reuse the existing finalization rather than creating another one.

The controller is neither the normal response composer nor a semantic reviewer of arbitrary Hebrew/English prose. It cannot establish prose truth through general language interpretation, execute domains, rerun Main, change execution facts, or restore mutation authority. The final semantic owner and its domain response contract own wording fidelity. Bounds/structure checks are not proof of arbitrary prose truth.

Only explicit unavailable userResponse in an otherwise valid completion enables the narrow fallback below. Malformed completions belong to global finalization, not response fallback. No agent or fallback bypasses this final-response gate.

Progress uses a generic Benson-owned deterministic boundary, conceptually `emit_progress(...)`; this is not a selected API or a new transport. The LLM may propose when an allowed notification is useful; deterministic Benson enforcement applies each domain's reviewed event, evidence, bounds and delivery policy. Recipient, conversation/thread, account and transport come exclusively from trusted current workflow/admission authority. No agent receives unrestricted `message.send`, arbitrary target selection or direct channel credentials. Select the exact implementation and registration only after supported OpenClaw runtime/delivery discovery; reuse native transport without another dispatcher, queue, store, scheduler or messaging system.

The boundary admits progress only for an authorized active run and eligible nonterminal workflow; it cannot be used to escape completion-only repair or impersonate a final. Domain owners retain factual/evidence predicates. Progress delivery is communication evidence, never proof of domain success, physical completion, stop or resource release. Missing/failed best-effort delivery must not fail valid execution or cause replay; a reviewed domain may explicitly require delivery and define failure handling through the ordinary lifecycle, without granting replay or release authority.

### 6.9 Owner composition and bounded Response Model fallback

For simple known verified domain-result shapes, prefer domain-local deterministic templates. For example, verified `operation = clean_room`, `room = kitchen`, `outcome = started` may produce "Jessica started cleaning the kitchen." That template cannot claim cleaning completed. The domain tool/renderer supplies wording from the same authoritative facts used in the completion.

Where a practical deterministic renderer is insufficient, the owning agent composes wording within its own agentic loop. Main composes contextual and cross-domain responses. Do not add a second LLM call merely to review arbitrary prose from the first. Semantic wording must preserve structured truth; deterministic domain rendering provides the stronger guarantee for state-changing result shapes. Structural validation alone cannot prove arbitrary free-text fidelity, and this limitation must not be shifted to Response Controller.

Retain a one-shot, tool-free Response Model solely for an otherwise valid final-workflow completion whose userResponse explicitly states unavailable. It cannot repair an invalid schema, malformed completion, or missing required field. It receives only minimal status, verified facts and their limits, warnings, errors, partial effects/uncertainty, pending clarification, and language/locale requirements needed for wording. It has no tools, mutation, workflow, execution retry, delivery authority, or hidden conversation/session dependency.

Fallback output is bounded wording, not another agent completion or a competing common schema. It cannot modify execution truth. Use only reviewed output contracts with deterministic constraints on factual claims and required coverage; when open-ended prose cannot be safely constrained, use a deterministic truthful failure response instead. This does not authorize a semantic review model or a general semantic validator in Response Controller.

If the one-shot fallback is unavailable, fails, or violates its bounded contract, use a deterministic truthful failure response preserving known effects, warnings, and uncertainty from the accepted completion. Never rerun Main/domain execution. A usable owner message follows normal handoff without extra response inference.

### 6.10 Global terminal finalization and completion-only repair

`benson_complete` names the conceptual run-settlement primitive of the Benson Agent Completion Protocol. It terminates/settles the current run and closes the workflow only when its reviewed completion condition is satisfied and the completion is workflow-final. It is infrastructure-owned, automatically applied to every Benson-managed agent run, and mandatory before successful completion is accepted. It is not a claim that an OpenClaw API with this name exists.

Every run enters irreversible completion-only processing when its execution settles. Only a workflow-final disposition authorized by the reviewed completion policy invokes the existing workflow owner's atomic membership/intent close transition under Section 6.4 before candidate validation. Cancellation, timeout, failure or uncertain finalization closes the workflow only if it satisfies a reviewed terminal condition; a run-only outcome can leave the workflow nonterminal. A nonfinal settlement preserves open workflow membership while the run stays terminal. Neither repair nor recovery reopens a closed workflow or terminal run; the later transport freeze is not the admission cutoff.

```text
Agentic execution / semantic composition
  -> settle domain execution; bind known facts and outstanding uncertainty
  -> bind reviewed policy and disposition; close workflow intent only if workflow-final
  -> benson_complete(candidate)
  -> deterministic schema + trusted evidence validation
       +-> accepted agent completion: NORMAL -> Completion Control / continuation
       +-> rejected -> precise structured validation failure -> same agent loop
             [completion-only; mutation and execution delegation disabled]
             -> corrected candidate -> benson_complete
             -> bounded budget exhausted / agent cannot continue
                  -> sufficient trusted evidence: runtime-built RECOVERED completion
                  -> insufficient evidence: canonical FAILED report
                  -> canonical validation + trusted binding -> established continuation
```

Validation checks the versioned kind, required fields including userResponse, status consistency, domain contract, and trusted request/run/agent/caller/route/authorization/provenance/tool/verification evidence. Malformed, incomplete, contradictory, stale, uncorrelated, or unsupported output cannot advance as success. An LLM final answer, end-of-turn signal, or prompt promise is not accepted completion.

On rejection return a precise structured error to the same run (failure code, affected field/constraint, and permitted correction grounded in available evidence). Repair consumes a bounded attempt budget; roughly three attempts is current design intent, not an architectural constant. The implementation defines counting, limits, interruption handling, and native enforcement.

**Completion retry is not task retry.** Once execution is settled and repair starts, deterministic runtime capability policy disables state-changing/domain mutation tools and any delegation or escape route that could execute work indirectly. Do not reopen them on retry, provider substitution, timeout, or restart. Only narrowly justified read-only access to already-existing evidence may remain. Unknown in-flight effects stay uncertain and under their existing reconciliation owner; repair does not infer zero execution from missing output.

For run-origin records, completion outcome is assigned by deterministic runtime, independently of the task/workflow's business outcome; Section 6.7 defines deterministic control-plane finals:

| Outcome | Meaning |
| --- | --- |
| NORMAL | The agent produced a valid completion accepted by benson_complete, either initially or within the bounded repair budget. The actual task may have succeeded, failed, or ended partially/with clarification. |
| RECOVERED | Agent-authored attempts were exhausted, but trusted existing evidence suffices for runtime to construct and validate a complete canonical trustworthy completion itself. Preserve the actual task/workflow outcome, including verified success; envelope-generation failure is not business failure. |
| FAILED | Runtime cannot construct a complete trustworthy task/workflow completion. Only this outcome represents system inability to establish trustworthy completion; known execution facts and effects remain intact. |

After exhaustion the LLM has no further obligation or attempt budget. Runtime applies the same evidence-sufficiency decision when timeout, cancellation or another terminal condition makes further agent attempts impossible, without changing cancellation or delivery eligibility. Runtime construction uses no execution replay or extra model call. RECOVERED requires every required semantic claim and binding to be grounded in trusted evidence and accepted by canonical validation; schema validity or filling required facts with guesses is insufficient. Contract-permitted uncertainty, such as a verified cleaning start with no claim of eventual completion, must remain explicit. Missing required meaning/evidence yields FAILED rather than a fabricated recovered result.

For RECOVERED, runtime may provide domain-local deterministic wording or the protocol's explicit unavailable userResponse state; lack of wording alone does not imply FAILED. For FAILED, runtime emits a schema-valid evidence-preserving failure report, explicitly reporting the inability to establish complete task/workflow semantics. That report is not a successful reconstruction of the missing completion. Preserve all known verified outcomes, warnings, errors, partial effects and uncertainty, using unknown/not-applicable fields where appropriate rather than fabricating business data. Both paths use the original trusted binding and canonical validation; inability to establish binding stays under native recovery, never an invented route. Model-authored outcome labels are not authoritative. Response fallback and native delivery recovery cannot change this completion outcome or authorize execution.

Raw malformed output never crosses as completion; downstream consumers receive only accepted canonical records, including RECOVERED completions and valid FAILED reports. An infrastructure crash can delay settlement or delivery; it does not permit raw-output release or imply successful finalization. Native recovery preserves run-terminal phase, trusted completion policy/disposition, workflow membership and accepted-intent revision (including irreversible closure when workflow-final), budget, evidence, completion outcome, accepted record identity and no-replay restrictions through existing lifecycle/persistence ownership, without a second completion store. NORMAL/RECOVERED/FAILED alone cannot promote a nonfinal result to workflow-final.

Every agent's AGENTS.md documents the obligation and its domain result contract. Native/provider structured-output constraints should additionally constrain generation where supported. Neither prompts nor provider schema support is the enforcement/trust boundary. Runtime validation and terminal interception are mandatory even if the model omits benson_complete or emits ordinary prose. Adding an agent must not require private finalizers, validators, retry state machines, or enforcement hooks.

The implementation plan must inspect the installed OpenClaw lifecycle/hooks/tool/schema/finalization surfaces and prove automatic coverage, repair re-entry, capability restriction, and restart behavior. If native surfaces cannot enforce an invariant, document the precise gap and propose the smallest Benson integration at the existing owner boundary. Do not invent a second framework, message bus, custom orchestration runtime, duplicate completion store, or alternate lifecycle system.

### 6.11 Scheduled delivery is a separate capability

Scheduled durable notifications intentionally delivered later remain the native runtime capability in Section 17, distinct from active-run progress and the interactive final-response boundary. Creating a reminder receives its interactive acknowledgment through Response Controller; later notification delivery follows the authorized durable job route. Any scheduled Benson agent run still inherits the global completion protocol; a deterministic notification payload does not need an agent run merely to use it.

Preserve deterministic notification intents' authorization, native correlation, idempotency, and failure semantics. Notification failure never reruns or rolls back verified domain work and does not grant agent-owned interactive channel access.

### 6.12 Frozen native delivery and independent execution evidence

Preserve the S09 delivery ordering:

```text
Final approved message
  -> prepare transport representation
  -> freeze user-visible semantic content and prepared payload
  -> existing OpenClaw outbound queue
  -> sendPrepared/provider delivery
```

After freeze, semantic content is immutable. OpenClaw owns physical channel delivery, native outcome, and durable recovery. Recovery for any joined admission resolves to the workflow's same finalization and native delivery identity, reusing the same frozen prepared payload; it does not fan out a final response per admission, re-render, call the Response Model, rerun Main/domain execution, or create a new finalization. Later admissions cannot join or alter this final under Section 6.4. Do not add a Benson outbound dispatcher, delivery queue, parallel transport, or delivery ledger.

Queued != delivered. A final interactive response requires one canonical final assistant message in the owning Benson conversation, correlated to all joined admissions, and a native delivery outcome or explicit durable recovery ownership. Canonical final transcript state, accepted completion, prepared/queued payload, provider delivery outcome, and durable recovery ownership are distinct evidence. The one-final-delivery invariant does not assert unverified provider exactly-once behavior: native retries/reconciliation retain the same delivery identity, and an ambiguous send is not permission to send another final. A queued-final signal or generated message does not prove delivery. Failure in finalization or delivery never reauthorizes execution.

Execution/tool evidence remains authoritative independently of UI/progress events. Any policy depending on whether execution occurred must use complete native execution evidence; absent visible progress/tool callbacks do not prove zero execution. Incomplete evidence remains uncertain and fails closed wherever zero-execution proof is required. Exact installed-version queue/preparation/sendPrepared integration must be inspected during planning; the ordering is an architectural invariant, not a claim about an undocumented native API.

---

## 7. Sub-agent runtime model

Every new sub-agent activation is fresh, temporary and isolated. A verified continuation may update an existing active workflow under its existing authority; it does not create a competing activation. Every Benson agent run, including Main, scheduled semantic runs, and future agents, inherits the infrastructure-owned terminal protocol in Section 6.10. Native yield/wait is a nonterminal suspension, not an exemption or successful workflow completion.

### 7.1 Fresh session

For a Main-delegated task, Main normally calls native `sessions_spawn` with explicit domain `agentId`, `context: "isolated"`, and the task-specific brief. For a direct route, deterministic orchestration must use a verified native binding with the same fresh isolated-run guarantees. OpenClaw creates the isolated session, loads the target runtime contract, and supplies only task-required context. The implementation plan must verify that binding rather than invent an API.

A new activation must not depend on a previous sub-agent's hidden conversation. Required prior semantics come from explicit authorized conversation/pending-context projection; continuing a currently active run follows Section 7.5.

Main must not use `context: "fork"` as a substitute for semantic context projection. Any exception requires a documented need for broader transcript context and a review of privacy, token, latency, and instruction-mixing risks.

### 7.2 Loaded environment

For Benson's native OpenClaw sub-agent runs, the target agent's active runtime instruction source is `AGENTS.md`.

`AGENTS.md` contains both:

- the agent's behavioral/domain contract and mandatory Benson Agent Completion Protocol obligation; and
- a concise `## Tools` section describing the approved deterministic interfaces, when to use them, their exact invocation contract, expected result shape, and important technical constraints.

`TOOLS.md` is retired and must not be treated as an active runtime source.

OpenClaw separately resolves the sub-agent's effective runtime environment, including:

- workspace;
- model;
- runtime context;
- native tool surface;
- tool profiles and allow/deny policy;
- execution host/sandbox policy;
- execution allowlists;
- zero runtime skills by default;
- explicitly approved runtime skills only when a documented exception exists.

The distinction is mandatory:

```text
AGENTS.md ## Tools
tells the model how to use approved interfaces

OpenClaw tool policy / allowlists
decide what the model is actually allowed to invoke

Deterministic tools and scripts
perform and verify the operation
```

Benson Main does not copy entire skill directories or tool definitions into the task prompt.

Main supplies a semantic brief for its own children; direct routing supplies the bounded request/context. OpenClaw supplies the isolated runtime, loads the target sub-agent's `AGENTS.md`, derives trusted context, and enforces effective tool policy. Completion Control uses native lifecycle correlation and the established CompletionRoute (Section 6.5); it does not assume every run has Main as its caller.

### 7.3 Temporary runtime context

An agent's final text alone does not end the task successfully. Global terminal validation must accept its NORMAL or RECOVERED completion, or its canonical FAILED report under Section 6.10, before any completion is consumed. Exhaustion alone does not determine task success or system failure.

After accepted completion and preservation of the evidence required for native continuation/recovery, temporary reasoning context may be discarded. Future runs must not assume access to that hidden context. Restart/recovery must preserve completion-only restrictions and cannot reopen execution to repair output.

### 7.4 Explicit persistent state

Anything required later must be persisted explicitly.

Reuse native lifecycle/session/task state for domain identity, native run/session and generation, requester, conversation/workflow binding, joined admission membership and accepted-intent revision, lifecycle status and join closure, continuation eligibility and recovery ownership where represented; capacity reservations apply only once hardening is enabled. Keep pending clarification grounding/revision/expiry explicit. Domain tools own durable operation/idempotency evidence and resource ownership; reference that canonical owner rather than copying its ledger. These facts must not depend on Main remembering them, agent prose, or hidden model state.

Compose a trusted control-plane view from these owners; the concept does not authorize a duplicate execution/session ledger. If required correlation or durable concurrency state is missing, first verify supported session extensions or existing domain metadata. A new persistence surface still requires a separately justified and approved design. Reminder/Calendar links, device capability state and audit records retain their existing domain owners.

Persist enough to distinguish a live executor, admitted/queued work, suspended/pending workflow, terminal run, and an uncertain orphan after restart. A missing terminal timestamp or an old session row alone is not liveness. A workflow may span multiple short-lived agent runs and remain nonterminal between them. Existing explicit clarification/domain waits retain their native/domain owner. Deferred capacity-pending work must be bounded durable workflow/domain state, not a waiting agent run or a new Benson queue/service. An LLM run may finish while its physical workflow or pending clarification remains active; release each kind of ownership only on its own verified lifecycle condition. Remaining physical/pending state does not reopen a finalized interactive workflow: a later admission uses normal new-admission routing with that explicit context.

### 7.5 Waiting and long-running work

Use OpenClaw's native sub-agent lifecycle mechanisms for native sub-agent work.

For a normal delegated run:

- use `sessions_spawn` to start the fresh isolated sub-agent;
- when Benson Main requires the child result before it can answer, use
  `sessions_yield` without a user-visible acknowledgment; the waiting turn is
  silent until correlated completion;
- allow native delivery of the child completion event only after global finalization has accepted its canonical protocol record;
- do not replace completion delivery with polling loops over session history, task lists, shell sleep, or process state.

For a direct run there need not be a waiting Main turn. Use native lifecycle completion with the trusted policy/finality/disposition binding: retain a callerless nonfinal result at existing workflow authority; route to Response Controller only when workflow-final eligible (Section 6.4). Completion events never re-enter new-request classification.

Long-running or externally delayed operations should use an approved durable deterministic worker, native job/condition mechanism, or scheduler instead of keeping an LLM turn alive indefinitely. Waiting state and dependencies must be explicit and restart-safe; this does not authorize a new infrastructure boundary.

For an external continuation, discover the exact eligible run through trusted native lifecycle facts and Section 7.4 correlation, not by domain name, timing or text search. Section 4 policy verifies requester/workflow authority before any supported lifecycle call. Active-run steering is preferred only when it preserves the intended run/workflow, provenance, permissions, completion destination and evidence; it cannot undo a tool call that already crossed the execution boundary.

Evaluate native queue steering, followup, pending-task resume and interrupt separately. Followup is a later turn, and interrupt cancels/replaces execution; neither may be silently substituted for same-run guidance. A native operation that falls back to a new turn when idle is eligible only if policy can prevent an unauthorized terminal-race activation. Native resume may retain task identity while assigning a successor run identity; prove the nonterminal workflow binding and restrictions rather than pretending the old run remains live. Terminal runs are not reopened for new requests or to repair output.

An admission acknowledgment does not prove that guidance was persisted, consumed, applied or completed. Preserve every contributing external turn and its linkage to the affected workflow/result; native batching must not erase requester provenance or lose a correction. Joined admissions use the shared final in Section 6.4 through benson_complete, the existing CompletionRoute and Response Controller. Prove durable membership, accepted-intent ordering, atomic join closure at terminal finalization, and recovery to that one completion/delivery before enabling joining; the shared-final policy itself is fixed, not deferred to implementation.

After restart, reconcile native ownership, accepted input and domain effects before continuing. Do not equate an in-memory queue with durable continuation, replay uncertain input, or release a physical owner merely because its LLM process ended. New input cannot reopen the mutation-disabled completion-only phase. If exact control-plane caller scope, atomic target binding or restart semantics are unsupported, keep that path unavailable and record the precise native gap under Section 27; do not patch core.

### 7.6 Native OpenClaw first

OpenClaw is Benson's agent harness. Built-in OpenClaw mechanisms are the default architectural choice for orchestration, session lifecycle, sub-agent delegation, completion delivery, permissions, and other harness responsibilities.

Use this preference order, subject to verified capability and architectural suitability:

1. existing native OpenClaw capability;
2. documented native OpenClaw primitive;
3. official OpenClaw Plugin SDK or supported extension point;
4. an existing high-quality external implementation;
5. only then a Benson-owned implementation at a stable supported boundary.

Benson MUST NOT modify, overwrite, monkey-patch or otherwise patch OpenClaw core/package runtime implementation as a normal integration mechanism. A Benson plugin outside core using the supported Plugin SDK is not an OpenClaw core patch. A documented SDK boundary is not a promise of compatibility across releases: current plugin APIs are experimental, so pin and verify supported host versions.

If a required invariant genuinely cannot be enforced without modifying internals, STOP before implementation and label the proposal OPENCLAW CORE PATCH. Identify the exact native capability gap, why native/plugin approaches are insufficient, version coupling and upgrade/maintenance burden, rollback, and the preferred upstream/native path if one exists. Obtain explicit Oren approval; general capability or architecture approval does not authorize a core patch.

Existing Benson-owned core changes are IMPLEMENTATION DRIFT relative to this policy. Preserve them pending separately approved analysis; the next implementation-plan redesign must decide for each whether to remove it, migrate to a native primitive, or replace it through an official plugin/extension. Discovery alone never authorizes removal or further modification.

Do not introduce a custom workaround, alternate waiting mechanism, parallel orchestration framework, or replacement primitive merely because a symptom suggests that a native mechanism may be failing.

Before concluding that an OpenClaw native mechanism is defective or unsuitable:

1. verify its current documented contract in authoritative OpenClaw documentation;
2. reproduce the behavior in the smallest isolated test;
3. inspect focused runtime evidence, including logs and trajectories where available;
4. inspect the relevant installed-version implementation when necessary;
5. distinguish the primitive itself from adjacent transport, persistence, channel, or observability failures.

Only consider an alternative after the native path is demonstrably unavailable, inadequate for the required semantics, or confirmed defective in the relevant runtime.

When an alternative is necessary, document the evidence and the architectural reason for using it.

### 7.7 Agent capacity and resource ownership

Keep Conversation, Workflow, Agent Run and Physical Resource distinct: a conversation binds authorized history; a workflow binds admitted intent and its logical task lifecycle; a run is a temporary executor; a resource has independently verified mutation ownership and release. Section 6.4's reviewed domain/operation completion policy determines workflow closure independently of run settlement. Neither shared conversation nor semantic similarity grants continuation or resource authority. A terminal run is never reopened; an eligible nonterminal workflow may activate a fresh isolated run with explicit durable state between runs. A terminal workflow remains closed even when domain effects or resource reconciliation continue.

Resource/domain safety is mandatory independently of Agent Run capacity control. Every mutation, whether reached from direct execution, a Main child, a successor or scheduled semantic execution, crosses the existing deterministic domain boundary. Jessica permits one physical mutation owner at a time: acquire/check ownership atomically before the side effect and fence every mutation against the current authorized owner/generation. Read-only work cannot acquire mutation authority or mutate indirectly. Another requester's stop/cancel/control requires explicit authorization; semantic relation or a shared conversation is insufficient.

Run/workflow success, cancellation, timeout, failure or restart does not release the robot. Release requires verified domain/physical evidence under the domain owner's predicate. Unknown ownership or partial/in-flight effects block conflicting mutations; restart/recovery reconciles ownership and stale actors fail-closed before reuse, without timeout unlock or blind replay. A start acknowledgment is not physical completion. Exact later completion may produce an authorized final without keeping the original run alive, subject to the existing final/notification identity and delivery rules; it never reopens or duplicates an accepted workflow final. Reminder retains its existing deterministic transaction, idempotency, serialization and recovery safety; it has no singleton physical-resource owner equivalent to the robot.

Global cross-caller Agent Run capacity/admission control is a deferred hardening target, not a prerequisite for the initial resource-safe phase. That target includes reviewed active/pending bounds, reservation identities, durable capacity-pending work, deterministic ordering/expiry, automatic promotion and pre-launch coverage across all authorized activation paths. Native lanes, per-session serialization and per-parent limits do not establish that global guarantee; the initial phase must not claim it. Busy Jessica mutations may reject truthfully without durable pending admission or automatic retry.

When global capacity control is introduced, domains select reviewed limits/classes/busy policy and Benson provides one generic deterministic enforcement mechanism through supported native boundaries. Bound and deduplicate pending work at its durable owner; it is workflow/domain state, never a waiting agent run. Before promotion, revalidate authority, intent, lifecycle/generation and domain/resource conditions, then create a fresh eligible run. Missing capacity policy or unsupported atomic/recovery binding keeps that hardening path unavailable. Existing authorized clarification, domain-outcome waiting and successor lifecycle do not imply a capacity-pending queue. No new store, queue, scheduler, service or lifecycle owner follows from this deferred target.

---

## 8. Minimal agent context and zero skills by default

Each sub-agent should receive only what it needs for its domain and current task.

### 8.1 `AGENTS.md`

For every Benson agent, including Main and future agents, `AGENTS.md` documents its canonical completion obligation. For dedicated domains it is also the canonical domain runtime instruction source.

It should define:

- agent identity and responsibility;
- domain boundaries;
- reasoning and orchestration policy;
- safety constraints;
- communication restrictions;
- canonical structured completion obligation and domain-specific result contract;
- final semantic ownership, explicit userResponse state, and completion-only no-replay behavior;
- high-level execution workflow;
- a concise `## Tools` section for approved deterministic interface guidance.

Behavioral policy must not be duplicated in skills, legacy workspace files, or parallel prompt sources. AGENTS.md instructs; infrastructure enforces benson_complete, schema/evidence validation, bounded repair, and deterministic RECOVERED construction or FAILED reporting for all agents. Native/provider structured-output constraints supplement this where supported, but neither prompts nor constrained generation replaces runtime validation.

### 8.2 `AGENTS.md ## Tools` and effective tool policy

The `## Tools` section inside `AGENTS.md` should define only the runtime guidance the model needs to use already-approved deterministic capabilities correctly, including:

- approved deterministic interface names or exact executable paths;
- when each interface should be used;
- required inputs;
- expected structured outputs;
- validation and failure expectations;
- important invocation constraints;
- explicit prohibitions against discovery or raw lower-level mutation when appropriate.

Keep this section concise. It is instruction context, not the security boundary.

Actual capability exposure is owned by OpenClaw configuration and execution policy:

- tool profile;
- per-agent tool allow/deny rules;
- sub-agent restriction policy;
- execution host/sandbox policy;
- execution allowlist;
- other explicit runtime permissions.

`AGENTS.md ## Tools` must accurately describe the capability surface that policy actually exposes. A mismatch is implementation drift.

`TOOLS.md` is retired in the current OpenClaw contract and is not an active Benson source of truth. Active Benson runtime behavior must not depend on it.

### 8.3 Skills

Dedicated domain sub-agents start with **zero runtime skills by default**.

A runtime skill may be added only as an explicitly reviewed and approved
exception when it provides a distinct, reusable, sufficiently complex
capability that cannot be represented cleanly in:

- `AGENTS.md`, including its `## Tools` section;
- an approved deterministic tool or script;
- domain data;
- domain documentation;
- tests.

Before adding a runtime skill:

1. locate the canonical existing implementation;
2. prove that the capability is not already available;
3. prove that a skill is preferable to deterministic code or documentation;
4. define its owner and exact loading scope;
5. verify that it does not duplicate behavioral or tool policy;
6. evaluate its token, permission, and security impact.

A runtime skill must not repeat:

- the agent's identity;
- its general workflow;
- its responsibility boundary;
- safety or communication policy;
- basic tool-selection rules;
- deterministic interface documentation that belongs in `AGENTS.md ## Tools`.

Skills stored for development, history, migration, testing, or maintenance must
not be automatically loaded into ordinary runtime sessions.

### 8.4 Avoid duplication

The same rule should not be copied into multiple active sources unless each copy has a clearly defined responsibility.

Preferred division:

```text
AGENTS.md
behavior, responsibility, reasoning policy, result contract
and concise ## Tools runtime guidance

OpenClaw tool policy / allowlists
actual capability exposure and least-privilege enforcement

Benson global finalization at the native lifecycle boundary
one completion protocol, validation, repair restrictions, and terminal enforcement

skills/
explicitly approved exceptional capability knowledge; absent by default

deterministic tools and scripts/
actual mechanical execution, validation, verification, persistence, rollback

architecture documents/
normative system design and maintenance intent
```

A standalone `TOOLS.md` is not part of the active canonical division.

---

## 9. Deterministic versus agentic responsibilities

The system should use the LLM where language and reasoning are valuable, and deterministic code where repeatability and state control are required.

### 9.1 Use the LLM for

- natural-language understanding;
- conversational context resolution;
- intent extraction;
- ambiguity handling;
- reasoning and planning;
- domain-task and model selection within Main-owned semantic orchestration;
- bounded Decision Model classification evidence, subject to deterministic routing;
- approved tool selection;
- summarization;
- explanation;
- user-facing wording inside the current final semantic owner when deterministic domain rendering is insufficient;
- narrowly bounded response fallback only for explicit message unavailability in a valid completion.

### 9.2 Use deterministic code for

- device commands;
- Home Assistant calls;
- input validation;
- authorization and allowlists;
- scheduler and Cron creation, update, and removal;
- Calendar event creation, update, and deletion;
- state persistence;
- file modification;
- backups;
- duplicate prevention;
- idempotency;
- structured logging;
- retry rules;
- transaction handling;
- rollback or compensation;
- output delivery mechanics;
- stable result schemas;
- admission deduplication and exclusive execution commitment;
- routing eligibility, trusted completion destinations, and correlation;
- global completion validation, trusted evidence binding, bounded repair, and runtime-built RECOVERED completions or FAILED reports;
- disabling mutation/delegation during completion repair and retaining that restriction across recovery;
- domain-local response templates, outbound eligibility/bounds, and immutable prepared-payload handoff.

### 9.3 Decision rule

Prefer deterministic execution whenever the task is:

- mechanical;
- repeatable;
- stateful;
- safety-sensitive;
- externally observable;
- permission-sensitive;
- expected to produce the same result for the same validated input.

Inside an agent, semantic reasoning is flexible. At every completion boundary, the versioned structured protocol is strict. Externally observable operations use deterministic execution and verification; agent finalization uses deterministic validation; final outbound delivery uses the deterministic gate and native durable transport. An LLM may select an approved operation, but a deterministic tool performs and verifies it.

### 9.4 No free-form state mutation

An agent must not freely construct shell commands, raw Home Assistant calls, Cron state, Calendar mutations, or configuration edits when an approved domain tool exists.

### 9.5 Idempotency

Every externally visible operation should be idempotent where practical.

Retries must not create duplicate reminders, duplicate Calendar events, repeated device commands, or conflicting state.

### 9.6 LLM boundaries and minimum cognitive hops

Use the minimum semantic/model hops required for reliable execution. Main reasons about broad context and workflows; domain agents reason inside their domain; deterministic tools perform mechanical execution and verification.

The target permits two narrow one-shot capabilities: Decision Model classification before route commitment, and Response Model wording only for explicit userResponse unavailability in an otherwise valid final-workflow completion. Both are stateless, tool-free, and bounded. Measure reliability, latency, and total cost; the Response Model is never ordinary composition or completion-schema repair.

Prefer domain-local deterministic rendering for known outcomes; otherwise the current final semantic owner composes within its existing loop. Completion-only repair uses that same run under Section 6.10. Do not introduce response-to-Main semantic continuation or a second model merely to review prose. Avoid chains such as classifier -> evaluator LLM -> planner LLM -> Main -> renderer LLM -> summarizer LLM. Additional stages require a concrete justified responsibility.

A domain agent may need several model turns inside its native tool loop. Those turns are part of one focused run, not extra architectural agents.

### 9.7 Illustrative inference budgets

These are responsibility budgets, not claims about the installed provider-call count:

| Path | Expected semantic/model work |
| --- | --- |
| Direct domain + owner-composed/domain-rendered response | One bounded Decision inference when enabled, plus the domain run's native tool loop; no Main or Response Model inference on the ordinary accepted fast path. |
| Grounded active-domain continuation | Bounded Decision evidence from native context, then authorized continuation of the existing run when supported; no mandatory Main call or new per-request summarization. |
| Explicit unavailable final message | Otherwise valid completion plus at most one bounded response inference; deterministic truthful response on fallback failure. |
| Main-only | Decision when enabled, then Main reasoning; a usable final userResponse needs no Response Model call. |
| Main + domain(s) | Decision when enabled, Main orchestration/continuation, and required domain tool loops; Main owns final wording, avoiding redundant downstream synthesis. |
| Completion-only repair | Bounded same-run completion attempts with execution disabled; exhaustion leads to runtime-built RECOVERED completion when trusted evidence suffices, otherwise FAILED. |
| Simple scheduled reminder fire | Zero LLM calls when the content and route were already determined. |

Measure actual native spawn/yield continuations, provider calls, stage latency, tokens, and cost. Disabled/unavailable classification may select Main without a provider call. These target budgets do not prove current production routing.

The deterministic Reminder adapter should resolve schedules, native Automation mutation, Calendar linkage, idempotency, rollback/compensation, and verification within one deterministic transaction where practical. Mechanical internal steps must not add LLM hops. Scheduled tasks require a model at fire time only when the future task itself explicitly requires fresh semantic reasoning.

---

## 10. Reliability-first design

Reliability is the primary goal.

### 10.1 Verified outcomes

Never claim that an operation succeeded unless the success condition was observed.

A tool accepting a command is not always proof that the physical or external action completed.

Examples:

- a Home Assistant service call is not proof that the device moved;
- a process start is not proof that it completed;
- an LLM-generated success sentence is not proof that state changed;
- a Calendar request is not proof that the final event exists.

### 10.2 Fail closed

When verification is unavailable or contradictory, Benson must fail closed.

It should say that the result could not be verified rather than inventing a success.

Fallback models must follow the same rule and must never claim unverified operations.

### 10.3 Structured errors

Errors crossing agent completion boundaries must be classified in the canonical structured protocol, including canonical FAILED reports when runtime cannot establish a complete trustworthy completion. Diagnostic detail remains bounded and owner-safe.

Useful fields include:

- failure stage;
- retryable or non-retryable;
- side effects observed;
- verification status;
- rollback status;
- user-safe message;
- owner-only diagnostics.

### 10.4 Retry discipline

Retries must be explicit, bounded, and safe. Completion-only retries cannot execute tasks: mutation and execution delegation remain disabled. Delivery retries reuse the frozen prepared payload. The following side-effect checks concern separately authorized execution recovery, not permission to replay work for presentation repair.

Before retrying a state-changing operation:

1. inspect whether the first attempt produced side effects;
2. use idempotency keys or deterministic matching;
3. avoid duplicating the operation;
4. record the retry and result.

### 10.5 Timeouts and interrupted runs

A runtime timeout does not prove that the underlying operation failed.

If a tool call or agent turn ends before receiving a result, reconcile native/durable execution evidence before considering any separately authorized execution recovery. A missing callback or UI event is not proof that no execution occurred. Completion repair preserves uncertainty without replay.

Long-running operations should write durable progress and completion records.

### 10.6 Execution commitment and retry safety

Exactly one initial execution owner exists for a committed request. A continuation admission is bound once to its authorized workflow action, not also dispatched as a competing Main/direct request. Native admission identity distinguishes retransmission of the same admission from a genuinely new identical-text request. Commitment and dispatch recovery must exclude competing execution, including timeouts, restarts, steering-to-followup races, and cancellation; a local flag or model promise is insufficient.

Before commitment, classifier/provider/routing failure may safely select Main. Once domain execution has been dispatched, accepted, or its outcome is uncertain, do not replay the original request through Main as fallback. Reconcile native lifecycle/correlation, domain durable state, idempotency, and deterministic verification first. Uncertainty retains recovery ownership and fails closed; it does not create a second owner.

Apply the same discipline to child tasks inside Main workflows. Prevent duplicate reminders, Calendar events, and physical-device actions. Completion repair, response fallback, and native delivery recovery have separate scopes (Sections 6.9-6.12); none reauthorizes execution. Policies requiring zero execution must use complete native execution evidence, independently of UI/progress events.

---

## 11. Token efficiency and low cost

Token efficiency is a design requirement, but it is subordinate to reliability.

### 11.1 Minimum sufficient context

Pass the minimum **sufficient** context, not the minimum possible context.

The selected context must be enough to avoid ambiguity and rediscovery.

### 11.2 Avoid unnecessary context

Do not pass:

- the entire conversation by default;
- unrelated domain history;
- duplicate copies of the same policy;
- unused skill documents;
- full tool output when a structured summary is sufficient;
- current-state dumps when a focused query is available.

### 11.3 Avoid rediscovery

Benson Main should include known relevant facts so the sub-agent does not need to rediscover them.

Examples include:

- the active conversational reference;
- trusted runtime date and timezone supplied through the runtime plane;
- the user's actual goal;
- previously confirmed choices;
- unresolved pending context;
- the required output contract.

### 11.4 Model economics

Choose the least expensive and fastest model that can reliably complete the task.

Escalate when complexity, ambiguity, risk, or expected impact requires a stronger model.

Do not use a weak model when doing so materially increases retries, errors, or recovery cost.

### 11.5 Compact structured results

Tools and sub-agents should return compact structured results rather than verbose reasoning transcripts.

Callers and the Response Controller need compact structured facts and their verification limits, not hidden chain-of-thought. Decision and Response Models receive only their bounded projections (Sections 4.2 and 6.9).

---

## 12. Low-latency design

Low latency is achieved mainly by removing unnecessary work.

### 12.1 Latency principles

- select the correct agent once;
- send a complete task brief;
- avoid repeated clarification when context already resolves the request;
- avoid loading irrelevant context;
- avoid unnecessary model escalation;
- use deterministic tools for mechanical work;
- minimize tool round trips;
- prefer focused status checks;
- use structured outputs;
- avoid polling loops;
- avoid rediscovery of known facts;
- avoid unnecessary inference across request classification, Main, domain execution, continuation, and response generation;
- measure safe Main bypass, owner composition, completion repair, and explicit response fallback against reliability, latency, and total cost.

### 12.2 Reliability versus speed

A fast unverified answer is a failure.

The target is the lowest latency that still preserves correctness, verification, safety, and observability.

---

## 13. Least privilege and security boundaries

Each sub-agent must have access only to the files, tools, APIs, and data required for its domain.

### 13.1 Explicit allowlists

Prefer explicit allowlists over broad access.

A domain agent must not receive generic control over unrelated services.

### 13.2 Home Assistant boundary

A domain agent must not bypass approved deterministic tools and call raw Home Assistant services unless that capability was explicitly designed, reviewed, and approved.

### 13.3 Self-modification

Runtime agents must not edit their own:

- prompts;
- `AGENTS.md`, including its `## Tools` section;
- skills;
- scripts;
- policies;
- configuration;

unless the user has explicitly approved a maintenance task and the change follows the controlled engineering process.

### 13.4 Secrets

Never request, expose, print, log, snapshot, or embed:

- passwords;
- API tokens;
- OAuth tokens;
- credentials;
- private keys;
- certificates;
- raw authentication files;
- secret environment files.

Do not manually edit secret or authentication stores.

Use approved authentication mechanisms and minimal required permissions.

### 13.5 Model and control-plane trust boundaries

Trusted requester identity and channel/session binding come from OpenClaw/runtime context. Classifier evidence or confidence never grants authorization. Authorization, validation, explicit tool allowlists, least privilege, and zero runtime skills by default remain enforced close to deterministic mutation on both Main and direct routes.

Apply authorization separately to reading conversation context and controlling a workflow. Same domain, shared thread, visible session or recent activity does not grant another user's continuation authority. Revalidate the exact requester, conversation, workflow and lifecycle generation at the control operation, then enforce domain/resource authority again at mutation. Neither a classifier-selected reference nor a model summary can widen those bindings.

Decision and Response Model outputs are untrusted model output. Validate bounded contracts before use; neither may author trusted routes, identity, permissions, verification, or delivery destinations. Agent-authored source/provenance/verification/response-policy fields must be checked against deterministic authority. Runtime-owned finalization disables mutation and execution delegation during completion repair; an agent cannot restore permissions by requesting another completion attempt. Model-generated success claims never replace deterministic evidence.

Review provider privacy/data handling before household content is transmitted. Even a single request can contain personal information. Decision Model receives only the authorized minimum routing projection in Section 5.3; Response Model retains the narrower verified-facts input in Section 6.9. Send neither secrets nor unnecessary history/internal metadata. A restricted or unsupported input keeps the direct path ineligible; it does not weaken authorization or permit cross-user context leakage through Main.

---

## 14. User-facing communication

For run-origin workflows, the final semantic owner composes the final user-facing message: the direct domain agent on eligible direct routes, Main on Main-owned workflows. Section 6.7's control-plane terminalization instead supplies trusted deterministic wording without creating a run. Benson Response Controller remains the single deterministic interactive final-response gate (Section 6.8). An active agent may request policy-controlled nonterminal progress through Benson's deterministic boundary; it cannot deliver directly. Accepted final wording proceeds through preparation, freeze, and native delivery (Section 6.12).

### 14.1 Family experience

Family members should receive concise, natural, useful responses.

Responses should focus on:

- what was requested;
- what was actually done;
- the verified status;
- an important warning or next step when necessary.

They should not receive internal IDs, tool names, paths, logs, or orchestration details unless explicitly appropriate.

### 14.2 Sub-agent communication authority

Sub-agents must not send directly to:

- WhatsApp;
- voice channels;
- other user-facing channels.

They may initiate approved nonterminal progress only through Section 6.8's generic deterministic boundary with trusted workflow recipient binding. This grants no unrestricted messaging tool or channel/recipient authority. They submit domain-task completions through benson_complete and trusted Completion Control. Main submits final-workflow completion through the same protocol. Final-eligible direct domain completions are projected into the final-workflow kind before Response Controller; progress never bypasses or substitutes for global terminal finalization.

### 14.3 Truthful finalization

Every Benson response path must preserve the meaning of the verified domain result.

It must not convert a list result into a generic creation confirmation, erase warnings or partial effects, change authoritative times, or replace an error with an invented success.

Use domain-local templates for known verified results and owner composition for broader semantics (Section 6.9). Explicit unavailable userResponse alone enables bounded fallback; malformed response state is a completion violation. Response Controller does not interpret arbitrary prose to verify its truth. Native recovery preserves frozen semantic content; no response path replays execution. Historical evidence and current verification limits are recorded in Section 27.

---

## 15. Owner-only observability

Oren may receive operational execution reports, not hidden chain-of-thought. Other family members receive concise ordinary responses without internal details by default.

Trace native conversation/admission -> bounded context/workflow view -> Request Controller -> optional Decision Model -> continuation policy or ordinary routing -> current domain/resource eligibility -> execution owner/run -> atomic domain ownership/fencing and deterministic tools/evidence -> owner composition -> benson_complete validation/repair -> accepted canonical completion -> Completion Control -> caller continuation or final-workflow projection -> Response Controller -> explicit-message fallback only if eligible -> preparation/freeze -> native queue/provider outcome/recovery. Main continuation and finalization remain linked to the same workflow; Main-only paths omit domain stages.

Record narrowly scoped structured evidence sufficient to measure:

- request/admission correlation, policy version, candidate, final route, and route reason;
- authorized conversation/session generation and context cutoff, projection version/size and omission/uncertainty indicators, without copying raw history;
- continuation candidate versus authorized workflow/run, requester-scope checks, joined admission membership and accepted-intent revision, accepted/consumed guidance evidence, join closure, and terminal-race or recovery disposition;
- resource owner, atomic acquisition/busy denial, mutation eligibility, stale-owner fencing and verified reconciliation/release; agent-capacity reservations and capacity-pending outcomes become required only when hardening is enabled;
- decision provider/model/rubric version and meaningful decision evidence;
- execution owner, completion destination, native child/caller run correlation;
- domain/tool outcomes, verification, partial effects, retries, and reconciliation;
- protocol version/kind, validation failures, repair attempts/budget, terminal phase, and enforced mutation restriction;
- NORMAL/RECOVERED/FAILED completion outcome, evidence-sufficiency decision, actual task/workflow status, preserved effects/uncertainty, and accepted record identity;
- final semantic owner, domain-rendered versus agent-composed wording, explicit userResponse state, and fallback eligibility/outcome;
- shared final-message correlation for all joined admissions, prepared/frozen payload and native delivery identity, queue admission, and separate native delivery outcome or durable recovery ownership;
- native execution-evidence completeness, separately from UI/progress callbacks;
- latency per stage, model calls, and tokens/cost when observable;
- Main bypass rate, fallback-to-Main rate, false-fast-path rate, and explicit message-unavailability/fallback rate, agent-attempt exhaustion rate, RECOVERED rate, and FAILED rate separately; exhaustion alone is not system completion failure.

False-fast-path measurement requires reviewed eligibility/outcome evidence; classifier confidence alone does not establish correctness. Define denominators, labels, and privacy-safe evaluation in the implementation plan. Do not unnecessarily persist sensitive raw requests, results, or response content.

---

## 16. Model selection

Model selection is performed per task and per sub-agent run.

### 16.1 Selection criteria

Consider:

- task complexity;
- ambiguity;
- safety and impact;
- required reasoning depth;
- context size;
- expected tool use;
- latency target;
- cost;
- provider availability.

### 16.2 Reliability-aware routing

Use the least expensive model that is expected to complete the task correctly.

Escalate when the weaker model is likely to reduce reliability or increase total cost through retries.

### 16.3 Fallback behavior

Fallback models must respect the same policies, permissions, result contracts, and fail-closed requirements.

A fallback must never claim that a state-changing operation succeeded without deterministic evidence.

Decision capability unavailability selects Main only before execution commitment. Response capability unavailability selects an approved response-only fallback. Provider/model substitution does not move execution ownership, replay mutations, or bypass the Response Controller. Exact model/provider choice is replaceable behind the stable bounded contracts.

---

## 17. Scheduling, reminders, and deferred execution

Scheduled work requires deterministic ownership.

### 17.1 Creation and lifecycle

OpenClaw Automations is Benson's default scheduler, durable job store, run-history store, and scheduled-delivery substrate. Benson must use its native create, get, list, edit, enable, disable, remove, run, and verification surfaces before considering any custom scheduler or registry.

The LLM may understand the user's scheduling intent, but an approved deterministic Reminder adapter must:

- normalize and validate the schedule;
- resolve relative and local calendar expressions against a trusted runtime time base;
- translate semantic schedule input into native OpenClaw Automation parameters;
- create or modify the native Automation job;
- prevent duplicates;
- manage linked Calendar state through the approved OpenClaw Calendar capability;
- verify the result;
- support update, pause, resume, and removal;
- provide rollback or compensation where possible.

The adapter must not implement a second scheduler, run-history store, delivery ledger, or complete Reminder registry. It may persist only the smallest domain metadata not represented by OpenClaw, such as a verified Automation-to-Calendar link, and should use an approved OpenClaw persistence surface when one exists.

### 17.2 Durable execution

A scheduled action must not depend on the original LLM session remaining alive.

The native Automation job, payload, recipient, delivery route, runtime status, and run history must be explicit and durable.

A simple reminder with already determined content must use a deterministic Automation payload and native durable delivery without starting an LLM run at fire time. A scheduled LLM run is justified only when the future task itself requires semantic reasoning or fresh model-based synthesis; it automatically uses the same Benson Agent Completion Protocol and global terminal enforcement.

### 17.3 Clarification continuity

Short follow-up answers must be linked to explicit pending context.

Do not treat a clarification answer as a new unrelated request.

For Reminder continuations, pending context carries a bounded, route-bound
provenance bundle: immutable per-turn evidence, a stable context id and
revision, current-turn evidence id, expiry, and field-level citations. The
workflow owner preserves that bundle and adds only the new answer supplied to
the domain; it does not synthesize a transcript. The deterministic Reminder
boundary compares cited evidence with external user turns in the trusted
canonical conversation binding, including the last turn from the same sender, and
rejects stale, foreign, altered, or incomplete provenance before mutation.

Reminder clarification follows the trusted CompletionRoute: a Main child returns to Main; an eligible direct result reaches the Response Controller through deterministic normalization. The active external turn's final clarification always passes through the Response Controller. Native interactive question state is not created from an internal completion-report run, and unrelated external messages must not be consumed by a pending question owned by another caller.

A new external clarification answer enters Section 4 continuation policy first. Verified pending context can ground an eligible domain continuation without Main; unresolved dependencies or an unverified direct binding require Main/clarification. A terminal prior run requires a fresh isolated activation with explicit pending context. Preserve the existing route-bound evidence requirements: the current Main-bound implementation remains valid for that path until a separately verified canonical-conversation binding supports direct continuation. This target does not relax Reminder provenance to enable a fast path.

### 17.4 Atomic Reminder plans

A single logical Reminder request may contain multiple delivery schedules,
multiple recipients, and one independently scheduled Calendar event. It remains
one deterministic create transaction. The adapter stages the full
schedule-by-recipient Automation matrix, verifies the Calendar event and link,
commits enablement, performs durable readback, and compensates every staged
side effect on failure. The agent must not emulate this with multiple create
calls. Lifecycle notifications describe the logical plan, not its internal
Automation or Calendar mechanics.

A request for exactly two separate Calendar events is a distinct atomic
create-plan operation over two complete Reminder items. Each item remains a
normal independently manageable Reminder with one linked Calendar event. Its
Reminder schedule and Calendar event schedule are explicit strict one-shot
objects; collection, recurring, relative, and unrelated schedule fields are
rejected before mutation. Plan Calendar metadata is bounded to the event time,
duration, and primary Calendar selection. Summary is derived deterministically
from Reminder content; description, location, and model-supplied summary are not
admitted on this path. One deterministic tool invocation stages both items,
verifies both Calendar events and both Automation sets, commits both, and
compensates all known side effects on failure. The Reminder agent only selects
and supplies the grounded plan; it must not sequence create/delete calls itself.
A partial plan found during idempotent reconciliation fails closed rather than
blindly creating the missing item.


---

## 18. Device-domain execution

Device domains such as Jessica, Boiler, and Irrigation should follow a common pattern.

```text
User request
        ↓
Request Controller: authorized continuation OR Main/direct routing
        ↓
Existing eligible active domain run OR fresh isolated activation
        ↓
Domain agent reasons and selects approved capability
        ↓
Deterministic domain tool validates and executes
        ↓
Home Assistant performs integration
        ↓
Device state is verified
        ↓
Domain-local wording + domain-task completion -> benson_complete validation
        ↓
Completion Control -> CALLER/Main (aggregation + final wording + benson_complete)
                  or RESPONSE_CONTROLLER (direct final-workflow projection)
        ↓
Validated final-workflow completion -> Response Controller
        ↓
Prepare -> freeze -> native outbound queue -> sendPrepared/provider delivery
```

### 18.1 Safety-sensitive actions

Actions with physical, safety, or resource impact require stronger validation.

Examples include:

- dynamic robot coordinates;
- boiler activation;
- irrigation duration;
- repeated schedules;
- device commands affecting occupied areas.

The domain must define approval, validation, and verification requirements.

### 18.2 Read-only versus state-changing tools

Read-only status tools should be separated from state-changing tools.

State-changing tools should require explicit validated parameters and, where appropriate, confirmation.

---

## 19. File and responsibility organization

Keep files organized by responsibility.

Use dedicated locations for:

- agent runtime instructions, including concise tool guidance in `AGENTS.md ## Tools`;
- deterministic interface implementation and non-prompt technical documentation;
- skills;
- deterministic tools;
- scripts;
- domain data;
- configuration;
- architecture documents;
- logs;
- generated output;
- tests;
- backups and archives.

Before creating a new file, script, skill, policy, or configuration entry:

1. identify the responsible domain;
2. locate the canonical existing implementation;
3. inspect current behavior;
4. check for equivalent functionality;
5. extend or repair the canonical implementation when appropriate;
6. avoid parallel sources of truth.

Do not leave backups, candidates, generated output, or obsolete copies in active canonical directories.

---

## 20. Engineering and maintenance workflow

The root AGENTS.md owns Benson's engineering workflow, approval/review/push/PR gates, learning handoffs, rollback and maintenance procedures. It applies the global Codex engineering policy; PLANS.md owns the planning procedure. Runtime AGENTS.md files remain agent/domain contracts, not development workflows. Follow those owners rather than duplicating their procedures here.

### 20.1 Durable architecture rationale

Meaningful durable architecture decisions must leave a concise rationale in the existing canonical owner: problem, viable alternatives, decision, reason and important consequences. Research informs the decision under the engineering policy; neither trends nor implementation drift silently change approved boundaries. Do not create a parallel decision document merely for visibility or turn the active contract into a transcript or decision diary.

For native integration, distinguish the OpenClaw primitive and supported registration/extension surface from Benson's policy or domain contract. For example, native tool registration can expose a Benson deterministic tool while OpenClaw retains run lifecycle and permissions. An OpenClaw core patch couples the integration to internals instead; Section 7.6 makes that an explicit exception decision. This separation preserves native ownership without weakening Benson's required invariants. Exact binding feasibility still requires evidence.

Persistent architecture and behavior must remain understandable without hidden model/session memory. Operational success and architecture conformance require observed acceptance, not a changed document.

---

## 21. Snapshot workflow

Use `bensonsnap` after meaningful changes to:

- agent configuration;
- workspaces;
- architecture documents;
- `AGENTS.md`, including `## Tools`, or effective tool-policy/allowlist configuration;
- deterministic tools or scripts;
- model configuration;
- scheduling behavior;
- domain state structures.

The recommended workflow is:

```text
Apply and validate a focused change on the Pi
        ↓
Run bensonsnap
        ↓
Upload the new snapshot to the ChatGPT Benson Project
        ↓
Keep this architecture document and domain contracts in Project Sources
```

A new snapshot should supersede older snapshots for current-state work.

Older snapshots may remain as historical records but must not be mistaken for the latest state.

---

## 22. Required ChatGPT Project Sources

The Benson ChatGPT Project should contain at least:

1. `BENSON_SUBAGENT_ARCHITECTURE.md` — this normative architecture document;
2. the latest `benson-context-*.md` snapshot — current captured runtime state;
3. active domain contracts, such as Jessica and Reminder architecture documents;
4. focused maintenance or migration documents that remain canonical.

Recommended source roles:

```text
BENSON_SUBAGENT_ARCHITECTURE.md
stable architecture and operating principles

Domain contract documents
domain ownership, permissions, tools, and result contracts

Latest benson-context-*.md
current captured installation and runtime map
```

Do not rely on multiple old snapshots without clearly identifying the newest one.

---

## 23. Anti-patterns

The following patterns are prohibited or strongly discouraged:

- forwarding only the latest message when earlier context is required;
- forwarding the full conversation by default;
- making history visibility depend on Main having participated, or equating compaction summaries with exact turns/trusted workflow state;
- routing every contextual phrase to Main without checking authorized continuation, or steering by domain name/timing alone;
- treating per-session/parent concurrency as a global agent limit, or treating a terminal LLM run as release of a physical resource;
- allowing Main to duplicate domain-internal logic;
- allowing any agent to bypass the Response Controller for interactive user delivery;
- relying on long-lived hidden sub-agent memory;
- giving broad cross-domain tool access;
- direct raw Home Assistant calls when an approved domain tool exists;
- using LLM text as the only state store;
- free-form Cron or Calendar mutation by the LLM;
- claiming success without verification;
- retrying state changes without checking side effects;
- creating duplicate scripts, skills, or sources of truth;
- loading large irrelevant skill sets into every session;
- using a stronger or more expensive model without a reliability reason;
- optimizing cost or latency at the expense of correctness;
- placing secrets in prompts, logs, snapshots, or examples;
- editing authentication stores manually;
- broad refactors before focused inspection;
- replacing a documented native OpenClaw primitive with a workaround before isolating and verifying the actual failing layer;
- treating logical controllers as a reason to duplicate native lifecycle, transport, or persistence;
- trusting agent-authored completion destinations, verification, or response-policy claims;
- falling back to Main by replaying an already committed domain request;
- allowing response failure to trigger domain mutation;
- using Response Controller for ordinary composition or semantic review of arbitrary agent prose;
- calling a second model merely to review the first model's prose;
- accepting free-form completion or relying on prompt/provider schema constraints as enforcement;
- creating per-agent finalizers, parallel common schemas, or private retry state machines;
- treating missing/malformed userResponse as explicit message unavailability;
- enabling mutation or execution delegation during completion repair;
- fabricating facts or erasing side effects in a runtime-built RECOVERED completion or FAILED report;
- treating absent progress callbacks as proof of zero execution;
- re-rendering frozen payloads or adding a parallel delivery queue;
- treating a model's prose or confidence as authorization or proof of success;
- using free-form wording as the sole carrier of authoritative facts;
- adding extra LLM hops without a concrete semantic, reliability, or safety responsibility.

---

## 24. Reference flows and architecture acceptance examples

These are target architecture acceptance examples, not implementation tests or claims that production wiring exists. User examples are translated into English to keep this technical document English-only. All arrows use native OpenClaw lifecycle and delivery where available. Every agent terminal arrow passes through benson_complete; yields and caller continuations are nonterminal. Native bindings require implementation-time verification.

### 24.1 Direct fast path: clean the kitchen

User: "Tell Jessica to clean the kitchen."

The admission has no related active/pending workflow. Decision evidence identifies Jessica and a supported single-domain request. This example uses an explicitly reviewed verified-start completion scope under Section 6.4. The Request Controller validates context, authority and domain/resource eligibility and commits `executionOwner = Jessica`; RESPONSE_CONTROLLER becomes eligible only when that scope's verified close condition holds.

```text
User -> native conversation/admission -> bounded context -> Decision Model
  -> continuation check -> ordinary routing/domain policy -> fresh Jessica run
  -> Jessica interprets domain operation and selects approved tool
  -> deterministic authorization + atomic ownership/check/fencing -> mutation -> device verification
  -> Jessica domain-local wording + domain-task completion
  -> benson_complete -> accepted protocol record -> Completion Control
  -> final-workflow projection -> Response Controller
  -> final approved message -> prepare -> freeze -> native queue -> delivery
```

Jessica is the final semantic owner. Under this verified-start scope, a known verified started result uses its domain-local template: "Jessica started cleaning the kitchen." Under physical-completion scope, the same start result settles only the run and is retained nonfinal while the workflow waits; final ownership alone cannot project it into a final. Ordinary accepted fast-path execution requires no Main or Response Model inference. The final wording must reflect the verified domain outcome: accepted or started cleaning is not completed cleaning. A completion claim is allowed only if the domain result demonstrates completion.

The same general shape applies to an eligible direct Reminder request; the Reminder agent and deterministic tools retain scheduling semantics, authorization, and verification. It never gains interactive delivery authority.

**Active continuation:** before workflow W1 enters terminal finalization, the same trusted user/conversation says, "Actually, do two passes." The initial request is admission A1 and the correction is A2; Jessica R1 is W1's active execution.

```text
New external admission A2 -> same canonical conversation + trusted W1/R1
  -> bounded exact prior request/current correction + lifecycle metadata
  -> Decision continuation evidence -> deterministic authority/phase checks
  -> accept A2 into W1 before join closure; retain A1 and A2 independently
  -> supported same-run continuation of R1, if still eligible
  -> domain decides the permitted adjustment -> deterministic verification
  -> close W1 membership/intent at terminal finalization -> benson_complete
  -> one accepted final-workflow completion covering A1 and A2
  -> Response Controller -> one final message/delivery for W1's latest intent
```

Acceptance must prove that both turns remain independently visible without Main, that the correction reaches the exact authorized active workflow once, and that consumption/application is not inferred from queue admission. W1's single final addresses the two-pass request and its verified outcome or inability/uncertainty; A1 must not separately emit an obsolete one-pass final. Duplicate or recovery events for either admission reuse W1's completion, canonical final entry and delivery identity.

Exercise both sides of the join/finalization race. If A2 is accepted first, terminal finalization must include it. If W1 has begun terminal finalization (even before repair or payload freeze), A2 cannot join and goes through normal new-admission routing with current context and domain/resource checks; it cannot revise W1's closed intent or final. If R1 ended or the native binding cannot guarantee the target, policy must not silently start a replacement. Reconcile pending/resource state and choose the permitted fresh-run, wait or clarification path. Verify the same outcomes after restart without replaying uncertain work.

**Other user:** while Oren's workflow owns the robot, Ilana sends a Jessica request. It has its own requester/conversation binding and cannot implicitly steer Oren's run. Apply the reviewed domain/resource policy: a conflicting mutation may reject truthfully without capacity-pending or automatic retry. Independent read-only work grants no robot mutation rights; deferred global Run quotas are not a Phase-1 admission requirement. A shared family thread alone does not grant control.

**After terminal completion:** a later "and the living room too" still has access to the relevant canonical conversation, even after R1's temporary context is discarded. An eligible new domain activation starts fresh with that bounded context and current resource checks; otherwise Main resolves the dependency. Test the same continuity across native compaction and restart, with original-turn provenance and no replay of uncertain mutations.

### 24.2 Main plus domain: history-dependent rooms

User: "Tell Jessica to clean the rooms she did not clean before."

Here no trusted active/pending workflow or bounded context resolves "before". The dependency remains historical/ambiguous, so policy selects Main; the mere presence of a contextual phrase is not the reason.

Main determines whether the dependency is prior conversation, deterministic Jessica cleaning history, or a need for clarification. It projects only the minimum necessary conversational context. Jessica retains responsibility for domain history interpretation and approved tool use.

```text
User -> admission -> Request Controller -> Decision Model -> Main
  -> Jessica [completionTarget = CALLER; caller = Main]
  -> deterministic tools -> verification -> domain-task completion
  -> Jessica benson_complete -> Completion Control -> Main continuation
  -> Main final wording + final-workflow completion -> Main benson_complete
  -> Completion Control -> Response Controller -> prepare/freeze/native delivery
```

A missing reference produces an explicit clarification, not guessed rooms. Main's final response always returns to the Response Controller. A Reminder follow-up such as "And the day after tomorrow?" can instead take the grounded domain path when the bounded canonical context resolves its reference and all continuation/admission checks pass.

### 24.3 Main plus independent domains and conversation

User: "Tell Jessica to clean Amit's room, send her a reminder in one hour saying 'Benson test', and tell a joke."

This combines Jessica, Reminder Service, and general conversational generation. Decision evidence identifies mixed-domain/general orchestration, so policy selects Main.

Main decomposes the request. Independent Jessica and Reminder tasks may run concurrently once recipient/room references and authorization requirements are sufficiently grounded; unresolved references require clarification. Each child has `completionTarget = CALLER`, with Main as caller. Jessica interprets its domain. Reminder Service owns reminder-time semantics and approved deterministic execution; Main does not calculate a schedule. Main generates the joke.

```text
User -> admission -> Request Controller -> Decision Model -> Main
  +-> Jessica -> verified domain-task completion -> benson_complete --+
  +-> Reminder -> verified domain-task completion -> benson_complete -+
       -> Completion Control -> Main aggregation + joke + final wording
       -> final-workflow completion -> Main benson_complete
       -> Completion Control -> Response Controller -> prepare/freeze/native delivery
```

Main's final-workflow completion retains both authoritative results and its complete userResponse. If Jessica succeeds and Reminder fails, the response states both outcomes and may still contain the joke. It must not say everything succeeded or erase partial effects.

### 24.4 Main plus conditional domains: completion before reminder

User: "Tell Jessica to clean the living room, and only if she finished successfully, send me a reminder in one hour saying 'Benson test'."

This is a cross-domain conditional workflow. Policy selects Main. Main understands the execution dependency and invokes Jessica first. It must not dispatch Reminder in parallel.

The condition is evaluated deterministically against correlated structured domain facts:

```text
eligibleToCreateReminder =
    result.status == success
    AND result.verified == true
    AND versioned Jessica data demonstrates successful cleaning completion
```

Command accepted, cleaning started, timeout, missing completion evidence, or unverified outcome does not satisfy this predicate. Main supplies the workflow dependency, but deterministic/native orchestration must enforce the gate before the dependent Reminder mutation; free-form completion prose or Main's assurance is insufficient.

```text
User -> admission -> Request Controller -> Decision Model -> Main
  -> Jessica -> domain-task completion -> benson_complete
  -> Completion Control -> Main continuation
  -> deterministic completion-condition gate
       +-> satisfied: Reminder -> domain-task completion -> benson_complete
       |                -> Completion Control -> Main
       +-> not satisfied/unverifiable: do not create Reminder
  -> Main final wording + final-workflow completion -> benson_complete
  -> Completion Control -> Response Controller -> prepare/freeze/native delivery
```

If cleaning is still running and waiting is permitted, use the approved durable native/domain completion mechanism with explicit dependency state and bounded recovery. Do not keep an LLM turn alive, poll model-mediated state, or claim completion early. A later verified completion may resume the authorized pending workflow once; a terminal unresolved/failed condition creates no reminder.

Reminder Service resolves the relative-time semantics against trusted runtime time and the grounded user intent after the gate. Ambiguity about its reference point requires clarification rather than an invented timestamp.

For a failed or unverifiable condition, a truthful final response is: "I did not create the reminder because I could not verify that Jessica successfully completed the living-room cleaning." A verified Reminder creation also returns through Main and the Response Controller.

### 24.5 Main-only composition and explicit response fallback

A conversational request follows admission -> Request Controller -> optional Decision Model -> Main composition -> final-workflow completion -> benson_complete -> Completion Control -> Response Controller -> preparation/freeze/native delivery. Domain results may be empty; execution verification is not applicable.

An otherwise valid final-workflow completion with explicit unavailable userResponse may use one tool-free Response Model attempt over the minimal verified projection. If that fails, deterministic truthful failure wording preserves known effects and uncertainty. Missing/malformed userResponse instead returns to the same agent's completion-only repair; it never triggers this fallback directly. Response Controller does not call Main for semantic rewriting.

### 24.6 Malformed Jessica completion after a real cleaning start

Jessica's deterministic tool evidence verifies cleaning started, but its first completion omits userResponse. benson_complete rejects it with a structured missing-field error. Runtime disables mutations and execution delegation; Jessica can repair only the completion using existing evidence. She cannot issue clean_room again.

If Jessica supplies a valid completion within budget, the original trusted route receives NORMAL. If her attempts are exhausted but trusted evidence establishes the complete clean_room task result, runtime constructs RECOVERED: verified successful cleaning start stays task success, with warnings/partial effects and uncertainty about eventual physical completion preserved. If required task evidence or meaning cannot be established, runtime emits a FAILED report retaining whatever is known; it does not erase the observed start. CALLER/Main consumes the actual task outcome and separate completion outcome; a callerless nonfinal result is retained at the workflow owner, and only a policy-eligible workflow-final result is projected to Response Controller. None of these dispositions repeats cleaning or claims physical completion from a start. Repair/reconstruction cannot change the trusted completion policy or promote a nonfinal result to workflow-final; even if a repaired payload supplies a different destination, trusted CompletionRoute remains unchanged.

### 24.7 Frozen delivery recovery and missing progress events

A final message is prepared, frozen, and queued, then provider delivery fails. Native OpenClaw recovery retains the same prepared payload and retries delivery under its existing policy. It neither regenerates wording nor resumes an agent. Queued status remains distinct from delivered status.

If no tool/progress callback was visible before interruption, an execution-dependent policy still checks complete native execution evidence. Missing/incomplete evidence leaves execution uncertain and cannot justify dispatching the original request through Main or another domain run.

---

## 25. Architectural quality checklist

Before approving a domain or major workflow, verify these design/implementation obligations; they are not claims of current runtime compliance.

### Request routing and orchestration

- [ ] Benson and Main remain distinct; Main owns broad/unresolved contextual reasoning, dependencies, cross-domain orchestration, aggregation, and final semantics for its workflows.
- [ ] New external interactive admissions enter Request Controller; internal completions/recovery are not reclassified requests.
- [ ] Decision Model receives an admission-consistent bounded conversation/workflow projection and supplies evidence only; deterministic continuation policy precedes ordinary routing and commits one owner/action.
- [ ] Grounded continuations do not require Main; ambiguous, broad or multi-domain work and unresolved semantic dependencies (including historical references) do. Isolated briefs preserve exact current text and minimum relevant context.
- [ ] Direct turns remain visible in native canonical conversation history without Main; compaction, exact turns, model context and trusted pending state remain distinct under Sections 3.7 and 5.3.
- [ ] No full-transcript default, unjustified last-N policy, per-request Benson summary call or duplicate conversation store is introduced.
- [ ] Main does not duplicate domain operation logic or manufacture trusted runtime facts.

### Global completion and runtime permissions

- [ ] One versioned Benson Agent Completion Protocol covers Main, all current domains, and future Benson-managed runs automatically.
- [ ] TaskResultEnvelope and ResponseEnvelope are kinds/roles in that family, not parallel contracts.
- [ ] Every terminal path reaches benson_complete or its runtime reconstruction/reporting path; raw final prose cannot bypass it.
- [ ] AGENTS.md states obligations; provider structured output supplements mandatory deterministic enforcement.
- [ ] Trusted identity, route, authorization, provenance, evidence, verification, finality, and delivery policy cannot be model-granted.
- [ ] Malformed, incomplete, contradictory, stale, uncorrelated, and unsupported completions cannot advance as successful completion.
- [ ] Rejection returns structured errors to the same run under a bounded repair budget.
- [ ] Completion repair disables mutations, execution delegation, and indirect execution paths, including after restart or provider substitution.
- [ ] Only justified reads of existing evidence remain; repair never repeats completed/uncertain work.
- [ ] NORMAL, RECOVERED and FAILED are runtime-assigned and separate from task/workflow outcome; schema validity alone cannot establish evidence sufficiency.
- [ ] Exhaustion or terminal inability invokes deterministic RECOVERED construction when evidence suffices, otherwise a canonical FAILED report; actual success, failure, warnings, effects and uncertainty are preserved without replay.
- [ ] New agents require no private finalizer, validator, repair machine, or lifecycle hooks.
- [ ] Native lifecycle/persistence owns recovery; no duplicate completion store or alternate runtime is introduced.
- [ ] Domain runs remain isolated, least-privileged, with accurate AGENTS.md Tools guidance and zero runtime skills by default.
- [ ] Section 7.7 mandatory domain/resource safety applies at every mutation boundary, with atomic exclusive robot ownership, cross-user authorization, stale-generation fencing, verified release and fail-closed recovery. Global Run capacity/pre-launch/pending controls remain explicitly deferred.

### Completion Control and workflow continuation

- [ ] Completion Control binds canonical validation to lifecycle ownership, rejects duplicate/stale events, and applies trusted nonfinal retention/CALLER/workflow-final RESPONSE_CONTROLLER dispositions.
- [ ] Run settlement closes workflow membership only for a policy-eligible workflow-final completion; domain/operation policy is independent of agent identity and resource release.
- [ ] New-workflow pre-activation rejection proves NOT_STARTED; activation denial inside an existing workflow returns to its caller/lifecycle owner without closing the parent. Applicable existing native/domain wait terminalization uses trusted control-plane final authority without creating a run, atomically closes joined membership and cleans up only verified claims. Capacity-pending cancellation/expiry/reservation cleanup remains a deferred target. One eligible final uses the ordinary Response Controller/native path; duplicate/restart never fabricates execution, erases prior effects or reopens the workflow.
- [ ] Direct projection preserves the domain's facts and wording only when workflow-final eligible; nonfinal direct/Main results remain durable without a fabricated caller or final response. Main children return to Main without owning final delivery.
- [ ] Main aggregation preserves every result's version, identity, status, verification scope, warnings, and effects for bounded collections of any admitted size.
- [ ] Workflow continuation is distinct from terminal repair; dependencies use deterministic predicates over verified facts.
- [ ] Native suspension is nonterminal; long-running dependencies use explicit durable state without LLM polling.
- [ ] Active continuation preserves authority, phase, exact lifecycle binding and completion ownership; queue admission, consumption and effects are distinct. Terminal/race/restart handling cannot replay mutations or silently create another run.
- [ ] Each joined admission remains independently recorded/correlated; the shared final covers the latest accepted intent and verified effects/limitations. Admission ordering and join closure at workflow terminal finalization are deterministic and restart-safe; later admissions use normal new-admission routing.

### Composition, outbound boundary, and recovery

- [ ] The final semantic owner composes normal wording; simple domain results prefer deterministic domain-local templates.
- [ ] Structured facts remain authoritative; accepted/started/completed, failure, warnings, partial effects, and uncertainty remain distinct.
- [ ] userResponse is mandatory and discriminates usable versus explicitly unavailable; missing/malformed state is a protocol violation.
- [ ] Response Controller is the single deterministic interactive final-response gate, not normal composer or general semantic prose reviewer.
- [ ] Optional repeated active-run progress uses the generic bounded Benson policy boundary and trusted recipient authority; it never finalizes, closes membership, releases ownership, suppresses the final or grants direct messaging access. Best-effort failure cannot replay execution.
- [ ] Only otherwise valid explicit-unavailable final completions enable the one-shot tool-free Response Model.
- [ ] Fallback has no hidden context, tools, mutation, workflow, or delivery authority; failure uses truthful deterministic wording.
- [ ] No second model reviews arbitrary first-model prose; schema checks do not pretend to prove free-text truth.
- [ ] Exactly one final-workflow completion and one final interactive delivery serve all joined admissions; prepare -> freeze -> existing native queue -> sendPrepared/provider cannot fan out finals per admission.
- [ ] Queued != delivered; native outcome and durable recovery ownership are explicit.
- [ ] Duplicates/recovery from any joined admission reuse the same canonical final entry, completion and native delivery identity with unchanged frozen payload; later admissions cannot alter them. Recovery never re-renders or reruns agents.
- [ ] Scheduled notifications retain native delivery; scheduled agent runs still inherit global finalization.

### Evidence and implementation boundaries

- [ ] Execution policy uses complete native tool/execution evidence independently of UI/progress callbacks.
- [ ] Missing evidence stays uncertain; absence of callbacks is not zero-execution proof.
- [ ] Finalization/delivery failures never reauthorize execution; side-effect reconciliation and idempotency remain deterministic.
- [ ] Installed native surfaces are inspected before binding conceptual primitives; specific gaps require the smallest approved integration at the existing owner.
- [ ] No duplicate dispatcher, queue, transport, lifecycle, store, or agent framework is introduced.
- [ ] Observability links validation, repair restrictions, accepted completion, finality, freeze, queue, and native delivery without secrets or hidden reasoning.
- [ ] Minimum context/model hops preserve reliability; current runtime evidence remains separate from target design.

---

## 26. Normative summary

1. Benson is the system; Main remains its central cognitive orchestrator for broad/unresolved contextual and cross-domain work. OpenClaw-owned conversation continuity spans Main and direct-domain execution; Main does not own history (Section 3.7).
2. Request Controller supplies bounded native conversation/workflow context and checks continuation before ordinary routing. Deterministic policy binds one authorized action/owner; classification grants no authority (Sections 4 and 5.3).
3. Domains own internal reasoning and approved tool selection. Deterministic tools own authorization, execution, persistence, verification, and reconciliation.
4. All Benson agent runs inherit one versioned Benson Agent Completion Protocol. TaskResultEnvelope and ResponseEnvelope are domain-task and final-workflow roles in that family.
5. Every terminal run uses infrastructure-owned benson_complete to settle that run. Workflow closure additionally requires its reviewed domain/operation close condition and trusted workflow-final disposition; a nonterminal workflow may span fresh isolated runs with durable state between them. No raw final answer, prompt convention, or provider schema constraint replaces deterministic runtime validation.
6. Trusted runtime/tool evidence establishes identity, correlation, authorization, route, provenance, verification, and delivery policy. Model claims alone cannot establish them.
7. Completion Control retains callerless nonfinal results under existing workflow authority or delivers accepted structured completions to trusted CALLER or workflow-final RESPONSE_CONTROLLER destinations. Only eligible workflow-final direct results are projected; stale/duplicate/uncorrelated events cannot advance them.
8. Run-origin final semantic ownership determines normal wording: direct domain for eligible direct finals, Main for Main-owned finals. Deterministic control-plane finals use trusted policy-owned wording under Section 6.7. Domains prefer local deterministic templates for simple verified shapes.
9. Structured facts remain authoritative; wording cannot inflate outcomes or erase warnings, failures, partial effects, or uncertainty.
10. userResponse explicitly distinguishes usable and unavailable. Missing/malformed state triggers completion repair, never accidental response fallback.
11. Repair is bounded and completion-only in the same run. Runtime disables mutations and execution delegation; no completed or uncertain work is replayed.
12. NORMAL accepts a valid run-origin completion through benson_complete or an explicitly typed deterministic control-plane workflow final under Section 6.7; it does not imply workflow success or an agent-produced final. For exhausted or impossible run-origin repair, sufficient trusted evidence permits runtime-built RECOVERED completion preserving the actual task/workflow outcome; only inability to establish complete trustworthy completion is FAILED. Its canonical failure report preserves known facts/effects/uncertainty. Exhaustion is not business failure, and malformed output never crosses the boundary.
13. Every interactive final response passes through one deterministic Response Controller before native delivery. It enforces trusted finality, eligibility, bounds, and one final-workflow completion/delivery shared by all independently recorded joined admissions, reflecting the latest accepted intent. Joining closes when workflow terminal finalization begins; later admissions use normal new-admission routing (Section 6.4). Optional repeated active-run progress uses a distinct generic Benson policy boundary with trusted recipients, changes no run/workflow/resource finality and cannot replace the final. Neither boundary grants agents direct channel authority; Response Controller does not own ordinary composition or semantic prose review.
14. The tool-free, one-shot Response Model is only fallback for valid explicit-unavailable final completion. Failure uses deterministic truthful wording; neither fallback repairs protocol failures nor reopens execution.
15. Final approved message -> prepare -> freeze -> existing OpenClaw outbound queue -> sendPrepared/provider. Queued != delivered. Recovery reuses the frozen payload without re-rendering or rerunning agents.
16. Execution evidence is independent of progress/UI events. Incomplete evidence is uncertain and cannot prove zero execution. Finalization/delivery failure never reauthorizes work.
17. Conditional mutations depend on deterministic predicates over verified facts; native durable dependencies and scheduling avoid long-lived hidden agent state and polling.
18. Native OpenClaw owns transcript/context lifecycle and compaction, permissions, persistence, transport, outcomes, and recovery. Benson adds its contract at supported boundaries, without duplicate frameworks, conversation/execution stores, queues or dispatchers. Section 7.6 governs core exceptions; this revision authorizes none.
19. New agents inherit finalization automatically and require explicit deterministic concurrency policy. Fresh activations, active continuations, workflow ownership and resource ownership remain distinct under Section 7. AGENTS.md explains obligations; infrastructure and deterministic domain boundaries enforce them.
20. Reliability and truth precede token/cost/latency optimization. This target does not assert installed native API support or production acceptance; architecture review and separate implementation planning precede changes to runtime.

---

## 27. Ownership, current evidence, and future implementation

### 27.1 Canonical owner and revision scope

This file owns the approved target architecture; root AGENTS.md owns engineering execution and PLANS.md owns its planning procedure. The implementation plan translates the target into separately approved stages. Documentation approval does not authorize runtime, configuration, agent, installation or implementation-plan changes. Git/PR mechanics and recovery procedures belong to the engineering contract.

### 27.2 Current evidence and verification limits

Focused read-only inspection on 2026-10-02 identified the local OpenClaw package at `/home/oa/.npm-global/lib/node_modules/openclaw`, version `2026.9.6`, build commit `eb377ac59e6c9fd6c7705028034812becf00271b`, with shipped bundles, documentation and Plugin SDK. The active Gateway service points to that package. Snapshot `output/context/benson-context-20261002-115547.md`, generated 2026-10-02 11:55:47 IDT, records the same version. The separate local upstream-checkout path remains UNKNOWN. Current upstream was inspected read-only at commit [`9562d84d90d0761e6b5f0c97a8e3d05bfa08c805`](https://github.com/openclaw/openclaw/tree/9562d84d90d0761e6b5f0c97a8e3d05bfa08c805); it is not the installed revision. None of these observations proves the Gateway's in-memory bytes or Benson production conformance.

The 2026-08-23 compatibility baseline in Section 2.6 remains historical and must be reverified where relevant. Current official and shipped plugin documentation support extension outside core but mark plugin APIs experimental; supported host versions need explicit compatibility evidence. Existing preparation, tests, core patches and earlier acceptance do not prove implementation of the global completion protocol or narrowed Response Controller. The S09 principles preserved in Section 6.12 remain normative invariants, not a fresh deployment/E2E claim.

The following are verified source/API capabilities and limits, not acceptance of a Benson integration. Bundle names identify the inspected installed build and are not import targets for Benson code.

| Boundary | Verified evidence | Applicability / remaining limit |
| --- | --- | --- |
| Conversation versus execution identity | Installed `session-key-CBvmC8zz.mjs` builds agent-prefixed peer keys; `session-store-runtime` exports `getConversationSession` with agent plus channel/account/kind/peer/thread address, returning current `sessionKey`/`sessionId`. Current upstream retains that agent-scoped mapping. Inspected configuration uses `session.dmScope = per-channel-peer`. | A stable external address is not a route-independent execution key. Native conversation pointers exist, but a single canonical conversation across Benson's dynamic direct/Main paths, resets and final writes still needs binding proof. Configuration alone proves neither cross-account isolation nor workflow authority. |
| Transcript persistence and reads | Default durable session rows/transcripts are in the native per-agent `openclaw-agent.sqlite`. Installed SDK exports `getSessionEntry`, `readRecentUserAssistantTextForSession`, `loadTranscriptEventsSync` and transcript stats; `api.runtime.subagent.getSessionMessages` also exists. | These expose different views, not a universal atomic routing snapshot. Recent-text helpers normalize/project text and have limits; do not mistake previews for exact original turns or complete compacted context. Verify canonical entry provenance, authorization, bounded reads and revision consistency at the chosen seam. No production transcripts were dumped for this audit. |
| Compaction and context | `session-manager-DjC09C_X.mjs` appends compaction entries with `summary`/`firstKeptEntryId`; `session-D9cHHQGH.mjs` builds the current model view from retained entries. `compaction-CAzwgOuQ.mjs` invokes model completion for built-in summaries. Installed runtime/docs provide required pre-inference/overflow compaction and deferred post-delivery maintenance; original history is retained by compaction, subject to independent retention/reset policies. | Compaction is not deterministic summarization or guaranteed to run before Request Controller. Context-engine/harness choice affects ordering and representation. Consistent pre-routing access to summary plus exact turns and pending state remains to be proven; a new summarizer/context engine is not justified. |
| Admission and transcript custody | Supported `before_dispatch`/`reply_dispatch` hooks expose inbound/finalized context. `reply_dispatch` includes host lifecycle callbacks and `userTurnTranscriptRecorder`; assistant transcript receipts prevent duplicate appends. | These are candidate integration seams, not proof that a direct child records the external conversation correctly. Preserve native recorder ownership and prove direct input/final projection, abort/reset fencing and one canonical entry. Returning handled/queued status alone is insufficient. |
| Active-run discovery and caller scope | Installed subagent registry/control checks bind visibility and control to requester/controller session and store; current-generation checks compare child session/run/generation. Session inventories and native task state provide lifecycle evidence. Current upstream additionally exposes `gateway.readSessionFacts`; that helper is absent from the inspected installed runtime API type. | Do not import internal registry code or assume the upstream-only helper is installed. Select a supported read surface that proves current ownership, not recency or an unended row. Exact authorized access from Benson control plane to a directly spawned domain run remains UNKNOWN. |
| Continuation and recovery | Native queue `steer` targets an active session runtime; `followup` waits for a later turn, `collect` coalesces and `interrupt` replaces. Explicit `/steer` can fall back to a normal prompt. Crucially, installed `sessions-messaging-Bf8Z-8mt.mjs` and the pinned upstream `sessions-messaging.ts` map RPC `sessions.steer` to `queueMode: interrupt`. `sessions_send` exposes scoped continuation/resume semantics, including task-preserving resume with a successor run identity. | These names are not interchangeable. Prove exact target/caller/generation, no implicit new-run fallback, mutation-phase restriction, completion owner and the Section 6.4 shared-final membership/closure binding before enabling joining. Ordinary queued input custody is distinct from durable replay: the in-memory queue is not replayed after restart. Native interrupted-child recovery settles results rather than blindly relaunching execution. |
| Concurrency scope | Installed `hook-client-ip-config-BTyUP38r.mjs` configures the shared `subagent` lane; `sessions-spawn-tool-AW-VALLJ.mjs` enforces `maxChildrenPerAgent` against the spawning session. Current upstream docs instead describe ordinary subagent execution lanes per immediate spawning/controller session, with separate collector lanes. | Neither version's inspected mechanism establishes a global limit per target domain-agent identity, nor a physical resource lock. Do not copy current online concurrency semantics onto 2026.9.6. Global domain capacity and resource-owner recovery require separate implementation evidence. |

The selected Phase-1 direction is native conversation/transcript custody plus bounded read projection, deterministic continuation admission and mandatory domain/resource enforcement; global cross-caller Run capacity/pending enforcement remains deferred under Section 7.7. Routing every reference to Main adds inference and cannot recover a direct turn missing from canonical history; copying full history or summarizing every request adds privacy/cost and accuracy risks; sharing a persistent domain execution session breaks fresh activation/isolation. Native steering may avoid a new run, but only with proven caller and lifecycle semantics; followup/wait/reject are explicit policy outcomes, not silent substitutes. Existing supported session extensions are candidates for genuinely missing metadata, not approval for another ledger. This chooses the architectural responsibilities while deferring unproven native bindings.

### 27.3 Implementation drift and target status

The superseded architecture assigned normal response-mode selection/composition and semantic result escalation to Response Controller. The active target instead assigns composition to the final semantic owner and global terminal enforcement to infrastructure. Earlier optional candidate fields and independent result/response definitions are replaced by one protocol family with mandatory explicit userResponse state.

Implementation alignment is not established by a document edit. Existing agent contracts, code/configuration and the canonical implementation plan must be assessed and, where necessary, aligned with this approved target through separately reviewed and approved changes. Any mismatch is plan/implementation drift; historical stage acceptance does not override the active architecture or authorize unapproved replacement work. No unresolved ownership alternative is intentionally retained in this target.

Architecture approval does not establish implementation alignment or production acceptance. The canonical `BENSON_DECISION_ROUTING_IMPLEMENTATION_PLAN.md` owns staged implementation and acceptance under this architecture; stage progress there does not imply runtime deployment or conformance.

IMPLEMENTATION DRIFT relative to Section 7.6: the preceding 2026-10-02 read-only implementation-plan audit remains planning evidence. It inventoried ten core-patch artifacts under `integrations/openclaw/patches`. The 2026.9.4 artifacts are not literally applied to this installed line; several behaviors were ported into 2026.9.6 runtime compatibility. The 2026.9.6 admission and runtime-compatibility artifacts passed reverse-application checks; commitment/completion code is present with artifact differences and production flags false; the finalization artifact is not installed. The separate blocked R03 candidate is not deployed. These source-level findings are not proof of every live event path, and no patch receives retroactive approval. Retain the audit's component inventory and proposed dispositions for the later plan rewrite; preserve correct existing domain tools and accepted contract work meanwhile.

The current-only Decision input, Main-dependent context assumptions and missing verified continuity/concurrency bindings are additional target-alignment gaps. This documentation stage changes no implementation, runtime/configuration, agent/tool contract, patch artifact or implementation plan. The plan audit remains useful evidence; only its proposed future approach/stages must be reconsidered under this revised architecture after review, merge, synchronization and a fresh accepted-state snapshot.

### 27.4 Deferred native binding and implementation decisions

Implementation planning must retain the completed audit and close these evidence gaps before selecting or enabling the affected bindings:

1. Automatic interception of every Benson terminal path, including Main, children, scheduled semantic runs, future managed agents, plain model finals, errors, cancellation, and timeouts. `benson_complete` is conceptual, not a verified API name.
2. Supported native/provider structured-output/schema surfaces and deterministic evidence validation at the terminal boundary, independent of model compliance.
3. Same-run structured repair feedback, bounded attempts, irreversible completion-phase mutation/delegation restriction, evidence-only reads, and restart-safe recovery of that phase.
4. Native identity, parent/caller correlation, trusted route/finality binding, duplicate/stale rejection, caller continuation, and direct domain-to-final-workflow projection without a duplicate completion store.
5. Deterministic evidence-sufficiency validation and RECOVERED construction when agent attempts are exhausted or impossible; FAILED reporting only when complete trustworthy completion cannot be established. Preserve actual task outcome, existing evidence/effects/uncertainty and native recovery ownership when correlation is unavailable.
6. Complete native execution/tool evidence versus UI/progress callbacks, especially for policies requiring proof of zero execution.
7. One final-workflow completion and outbound finalization/delivery per workflow shared by its joined admissions, canonical transcript correlation, transport preparation and freeze before the existing native queue, sendPrepared/provider outcomes, and durable reuse of the same delivery identity and identical prepared payload.
8. One native canonical conversation binding across direct/Main routes, with exact admitted external turns, correlated final replies, authorized reads and reset/retention behavior independent of the execution agent. Prove this without invoking Main merely to write history.
9. Admission-consistent bounded routing projection: exact-turn and native summary retrieval, lifecycle/compaction ordering, cutoff/revision semantics, privacy filtering and failure handling. Compare native read/recorder hooks and supported SDK extensions; do not assume that pre-dispatch is post-compaction or choose a fixed last-N shortcut.
10. Supported active-run discovery and continuation from the direct control-plane caller, preserving requester authority, current run/task identity, generation and completion phase/destination. Prove the native binding for Section 6.4's approved shared final: durable admission membership and accepted-intent revision, atomic join closure at workflow terminal finalization, later-admission routing, and recovery without duplicate finals. Prove steering versus followup/resume/interrupt behavior; unavailable support keeps joining disabled without a core patch.
11. Mandatory domain/resource safety: atomic exclusive robot mutation ownership/check, stale-writer fencing on every mutation, verified physical release and fail-closed restart/reconciliation, distinct from Run/Workflow termination. Reminder retains existing transaction/idempotency/serialization safety. Global cross-caller Run capacity/admission, durable capacity-pending, ordering/expiry, automatic promotion and universal pre-launch coverage remain a deferred hardening gap under Section 7.7; neither native session lanes nor completion of Phase 1 closes that portion.

Exact wire encoding, schema technology/version migration, retry count, domain render coverage/localization, provider/model choice, output bounds, and evaluation budgets belong to the separately reviewed implementation plan. Ownership and no-replay invariants are already fixed here. If native support cannot enforce one, document the precise gap and compare supported native/plugin alternatives at the existing ownership boundary. Apply the OPENCLAW CORE PATCH exception gate in Section 7.6 if internals would change; new architectural boundaries still require separate approval. No logical component name grants permission to modify core.

Current primary references consulted on 2026-10-02 (online contracts may exceed installed support):

- [OpenClaw: building plugins](https://docs.openclaw.ai/plugins/building-plugins)
- [OpenClaw: Plugin SDK and API stability](https://docs.openclaw.ai/plugins/sdk-overview#api-stability)
- [OpenClaw: sessions](https://docs.openclaw.ai/concepts/session), [compaction](https://docs.openclaw.ai/concepts/compaction), and [context engines](https://docs.openclaw.ai/concepts/context-engine)
- [OpenClaw: runtime agent/session SDK](https://docs.openclaw.ai/plugins/sdk-runtime/agent), [background/subagent SDK](https://docs.openclaw.ai/plugins/sdk-runtime/background-work), and [message/transcript hooks](https://docs.openclaw.ai/plugins/hooks/messages)
- [OpenClaw: session tools and caller scope](https://docs.openclaw.ai/concepts/session-tool), [steering](https://docs.openclaw.ai/tools/steer), [queue durability](https://docs.openclaw.ai/concepts/queue), and [subagent concurrency/recovery](https://docs.openclaw.ai/tools/subagents/operations)
- [Pinned upstream: agent-scoped session identity](https://github.com/openclaw/openclaw/blob/9562d84d90d0761e6b5f0c97a8e3d05bfa08c805/src/routing/session-key.ts), [SDK transcript access](https://github.com/openclaw/openclaw/blob/9562d84d90d0761e6b5f0c97a8e3d05bfa08c805/src/plugin-sdk/session-store-runtime.ts), and [sessions.steer RPC semantics](https://github.com/openclaw/openclaw/blob/9562d84d90d0761e6b5f0c97a8e3d05bfa08c805/src/gateway/server-methods/sessions-messaging.ts)
- [Martin Kleppmann: correctness locks and fencing](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html): apply the stale-owner exclusion principle at the actual mutation boundary; do not infer safety from elapsed time or mandate a new lock service.
- [AWS Builders' Library: retries and idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/): retain request identity and reconcile uncertain effects before retries, including continuation admission. This production evidence supports the existing no-replay boundary.

Historical compatibility references (not reverified by this documentation alignment):

- OpenClaw, retired TOOLS.md: https://docs.openclaw.ai/reference/templates/TOOLS
- OpenClaw, Automations: https://docs.openclaw.ai/automation/cron-jobs
- OpenClaw, Gateway protocol: https://docs.openclaw.ai/gateway/protocol
- OpenClaw, message lifecycle: https://docs.openclaw.ai/concepts/message-lifecycle-refactor

This revision records the approved target architecture. Snapshot generation, implementation acceptance, and production acceptance remain separate obligations under Section 21; a snapshot must not be treated as proof of deployment or runtime conformance.
