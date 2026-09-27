# Benson control-plane implementation plan

Status: S01–S04 ACCEPTED (S03 staged and production-disabled; S04 provider-independent with Decision unavailable/not configured); OpenClaw 2026.9.6 upgrade prerequisite accepted; S05–S18 not started. Real provider binding, runtime routing activation and host changes beyond the approved S03 admission patch remain unapproved.
Date: 2026-09-25.
Canonical owner: `BENSON_DECISION_ROUTING_IMPLEMENTATION_PLAN.md`.
Authority: [approved target architecture](architecture/BENSON_SUBAGENT_ARCHITECTURE.md), especially Sections 3–7, 10, 13–17, 24–26. The operator's current request establishes architecture approval; historical review-pending wording in the architecture is not a new approval gate.
Execution policy: one bounded stage at a time; no stage is implemented by this document.

## 1. Objective and acceptance

Implement the approved request, execution, completion and response boundaries using the smallest supported native OpenClaw integration. Main retains contextual and cross-domain reasoning; every completed interactive workflow reaches Response Controller before native delivery. Exactly one initial execution owner is committed. Model output never grants authority, completion destinations, verification or delivery.

Completion requires all four flows in Section 7, the negative matrix, preserved domain safeguards, measured rollout criteria and verified native final-message/delivery evidence. An unavailable Decision capability permits ordinary Main operation but does not satisfy direct-path acceptance. A verified cleaning start does not satisfy the conditional cleaning-completion flow.

In scope: native capability mapping, versioned contracts, logical controllers, provider-neutral model bindings, deterministic response enforcement, Main continuations, multi-domain dependencies, telemetry, shadow, contract alignment, controlled activation and acceptance.
Out of scope: heartbeat investigation, checkpoint retention, `.migrated` cleanup, workshop skills, general model fallback changes and unrelated domain expansion. Jessica exact-completion capability is an explicit external dependency owned by its existing capability plan; this plan does not silently implement it.

No new agent, service, plugin registration, message bus, MCP/A2A layer, polling layer, state store or public tool is approved by naming a logical controller. Reuse `integrations/openclaw/benson-routing/` for pure policy/contracts and verified native owners for authority. A new integration/configuration surface requires the concrete S01 decision and Oren approval before implementation.

## 2. Evidence baseline and implementation drift

### Evidence limits

- Supplied snapshot: [2026-09-25 11:25:48 IDT](output/context/benson-context-20260925-112548.md), reporting OpenClaw `2026.9.4 (3a9d69d)` with successful inventory queries. It is captured evidence, not current E2E.
- Focused planning inspection independently verified installed package version `2026.9.4`, relevant source and non-secret configuration fields. No live request, provider inference, device action, service restart or deployment was performed. Running-Gateway equivalence to these files remains an S01 check.
- `/home/oa/.openclaw/openclaw.json`: plugin load paths name only the Jessica and Reminder domain-tool integrations; no `decisionModel` selection exists at top level, `agents.defaults`, or the three agent entries. This is scoped configuration evidence, not proof that every possible ingress extension is absent.
- Main workspace is `/home/oa/projects/benson/main`; Main permits explicit Jessica/Reminder child identities. Both domain agents have empty runtime skills and minimal tool profiles; their direct message tool is denied. Preserve effective authorization rather than inferring it from prompts.
- Root-loading verification (2026-09-25): `/home/oa/projects/benson/AGENTS.md` is the repository/Codex engineering contract, not production Main's runtime instruction file. Current Main workspace config and the installed `loadWorkspaceBootstrapFiles` resolve `main/AGENTS.md` without ancestor traversal; the read-only loader check returned that file only. Configured bootstrap extras contain no root reference and resolved as missing; no local domain-plugin bootstrap override was found. Main's runtime owner remains `main/AGENTS.md`. This verifies the configured installed loading path, not a new production E2E.
- Git source control is established at `/home/oa/projects/benson` with private GitHub repository `oilysheep/benson`. Git owns canonical source history, diffs, commits, branches and source rollback. Verified Benson checkpoints remain the rollback mechanism for runtime/configuration/state/package artifacts that Git cannot safely restore.

### Native capability map: evidence, not deployment approval

Installed source paths below are relative to `/home/oa/.npm-global/lib/node_modules/openclaw/`. Resolve their current equivalents in S01; bundle hashes/names are not stable APIs.

| Capability | Verified evidence | Remaining proof / stage |
| --- | --- | --- |
| Isolated child execution | `dist/sessions-spawn-tool-2GiVSHqU.mjs` defines `sessions_spawn`, isolated/fork modes and accepted `runId`/child-session results. [Session tools](https://docs.openclaw.ai/concepts/session-tool) documents isolated spawn, yield and policy restrictions. | Supported deterministic caller binding with identical permissions, identity and lifecycle; S01/S05. Internal `spawnSubagentDirect` is not approved as an import. |
| Pre-Main hooks/admission | `dist/dispatch-from-config-CmAXENud.mjs` contains `before_dispatch`, `reply_dispatch`, admission dedupe and native finalization paths. | These are candidate ownership locations, not an exclusive handoff guarantee. Map command/cancellation/retry ordering and all interactive channels; S01/S03/S05. |
| Hook timeout risk | `dist/hook-runner-global-BhDCl4qm.mjs`: claiming hooks use a timeout race, catch errors and continue; timeout alone does not join/cancel handler work. | Reject takeover based only on a hook's `handled` result or local boolean. Prove native commitment under late completion, cancellation and restart. |
| Decision role | No decision export was found in installed package exports. [Decision models](https://docs.openclaw.ai/concepts/decision-models) explicitly describes features added after released 2026.9.5; current docs do not establish installed availability. | Supported bounded controller invocation, provider lifecycle and cancellation; S01/S04. Jev/TypeSafe is one candidate, never a prerequisite for Main. |
| Automatic Decision consumer | [Experimental features](https://docs.openclaw.ai/concepts/experimental-features) says Decision assistance records intent without wiring automatic consumers. | A selected model or `decision_evaluate` agent tool does not establish safe pre-Main routing. Do not assume either is the Request Controller binding. |
| One-shot model helpers | Installed `dist/plugin-sdk/simple-completion-runtime.js` exports prepared completion helpers; [model helpers](https://docs.openclaw.ai/plugins/sdk-runtime/models) documents them, while [SDK subpaths](https://docs.openclaw.ai/plugins/sdk-subpaths) labels this surface private-local. | Resolve supported consumption and restricted tool-free execution before adoption. Presence is not permission for a third-party/private import; S01/S10. |
| Completion truth | Jessica `dist/completion.js:validateJessicaCompletion` compares final output with tool truth and native task evidence. It explicitly requires an `agent:main:` parent and current Main external turn. | Extend the canonical validator for trusted direct execution without weakening freshness. Reminder's prompt-level integrity recovery also needs deterministic enforcement; S06/S07. |
| Delivery/recovery | Native dispatch source contains transcript and conversation-turn reply ownership; snapshot captures native scheduled notifications. | One final transcript message, native delivery outcome/recovery and Response Controller coverage for Main/direct/failures are not proven; S09/S17/S18. |
| Restricted continuation / dependencies | Target requirements and current Main contracts are available. | Native per-continuation denial of tools/spawn/mutation, durable dependency gates and exact Jessica completion are unproven; S11/S13. |

Do not mandate an upgrade as the first action. S01 compares the installed supported surface with a qualifying stable release only when a concrete missing capability requires it. No development-build deployment, custom Jev HTTP call or unsafe hook takeover is a fallback.

### Drift requiring repair

| Owner | Current finding | Required change |
| --- | --- | --- |
| Root `AGENTS.md` | Repository/Codex engineering contract has Main-centric sole-user-facing wording; verified not injected as Main runtime AGENTS. | Correct only this engineering contract under the pre-S01 prerequisite in Section 3, before dependent Sol implementation sessions. Runtime-contract publication remains S15/S17. |
| `main/AGENTS.md` | Main owns final interactive communication/time wording, ordinary conversation answers directly, all children return to Main; Reminder integrity is partly instruction-driven. | Main produces ResponseEnvelope, uses trusted CALLER completion and preserved current-turn provenance; deterministic response/delivery control applies to all interactive output. S07–S09/S12/S15. |
| Domain `AGENTS.md` files | Describe Main as mandatory caller/final responder; Reminder envelope has no common schemaVersion. | Versioned TaskResultEnvelope and runtime-owned destination; retain domain semantics, freshness, zero skills and tool limits. S06/S15. |
| Routing preparation | Pure unregistered modules only. Classification requires two probability-typed scores; policy lifecycle booleans are input flags, not enforcement; task envelope is request-only. | Provider evidence must keep documented meanings. Add shared result/route/response contracts and bind policy to native authority. S02–S10. |
| Presentation preparation | Eight reviewed render shapes; four semantic, two unsupported and one notification-dependent case. Some branches are narrowly example-shaped and do not establish generic warning coverage. | Retain useful goldens; enforce every warning/partial effect for any admitted result, schema-version coverage, bounded collections and authoritative time reuse. S09/S10. |
| Old plan | Stale status/release assumptions, Jev-specific next gate and rendering centered on Main continuation; no complete Response Controller model. | Replaced by this plan. Old acceptance evidence remains in the checkpoint and retained assets. |
| Runtime versus target | Inspected config/contracts do not establish target controller wiring, direct completion, Response Model or universal response boundary. Jessica capability plan says exact task completion remains unavailable. | Treat as target gaps, not a demonstrated failure of an already deployed control plane. Require native proof and the external domain prerequisite; never equate start/docked with completed. |

### Asset disposition

Paths in the first rows are relative to `integrations/openclaw/benson-routing/`. Classification applies to future implementation; nothing is removed in this planning session.

| Artifact | Disposition | Implementation treatment |
| --- | --- | --- |
| `classification.mjs` | EXTEND | Preserve unavailable outcomes and exact minimal input projection; version evidence and provider-specific score semantics. Missing flags are unknown, never false by default. |
| `policy.mjs` | EXTEND | Retain pure fail-closed policy/default-off behavior. Add trusted response/completion prerequisites and native commitment integration outside the pure function. |
| `envelope.mjs` | EXTEND | Preserve exact request round-trip; add common versioned contracts here unless S02 demonstrates a necessary internal split. Do not confuse request envelope with TaskResultEnvelope. |
| `telemetry.mjs` | EXTEND | Add completion/response/delivery correlation and measurements through existing native diagnostics, with no new transport/store. |
| `rubric.json` | KEEP | Keep reviewed provider-neutral semantics; revise only for measured gaps with renewed label review. |
| `evaluation.mjs` | EXTEND | Keep deterministic metrics/denominators; add provider-evidence and end-to-end response/owner measurements without duplicating policy. |
| `presentation.mjs` | EXTEND | Keep validated deterministic mappings; replace narrow matching where generic schema invariants apply, add truthful coverage and safe fallback. |
| `tests/routing.test.mjs` | EXTEND | Preserve exact-text, unavailable, purity and policy tests; add contract/admission/commitment negatives. |
| `tests/evaluation.test.mjs` | EXTEND | Retain metric checks; cover optional/provider-specific confidence and observed lifecycle measurements. |
| `tests/presentation.test.mjs` | EXTEND | Retain eight goldens, purity and unsupported checks; add all response modes and adversarial truth/coverage failures. |
| `tests/fixtures/classification-cases.json` | KEEP | Preserve 26 reviewed cases and tuning/held-out grouping; add independently reviewed examples when needed. |
| `tests/fixtures/presentation-cases.json` | EXTEND | Preserve 15 reviewed cases; replace obsolete disposition assumptions with Response Controller paths; add multi-result/conditional/error cases. |
| Canonical old routing plan | REPLACE | This clean implementation plan is its sole active replacement. |
| Prior checkpoints, snapshots and accepted old stage records | HISTORICAL_EVIDENCE_ONLY | Retain only evidence still required for an active acceptance, rollback path, unresolved implementation dependency or current canonical reference. Retention/cleanup is separate maintenance; no indefinite retention of superseded records is required. |
| Existing executable routing assets | REMOVE: none | No whole artifact is proven redundant. Remove obsolete assertions only when their replacement invariant passes in the same bounded batch. |

Reuse domain owners: `agents/jessica-vacuum/lib/results.mjs`; `integrations/openclaw/plugins/benson-jessica-tool/dist/completion.js`; `integrations/openclaw/plugins/benson-reminder-tool/dist/{contracts,runner,index}.js`; `agents/reminder-service/libexec/reminder-service-core` and its canonical `format_user_datetime`. Do not copy business schemas, scheduler ownership or date policy into a parallel implementation.

Accepted preparation retained: old Stages 0A–0A3, reviewed corpus/rubric and renderer, historical 35/35 detailed offline assertions plus domain/patch regressions. Planning inspection matched the final recorded hashes for rubric, both corpora, evaluator, renderer and all three test files. This justifies preserving acceptance without rerunning unchanged suites; it does not validate new target contracts. Relevant checkpoint directories under `output/checkpoints/` are `benson-decision-routing-stage0a-20260922T214759Z`, `stage0a1-20260922T222925Z`, `stage0a2-20260922T230455Z`, `stage0a2-renderer-20260923T062541Z` and `stage0a3-20260923T063803Z`, each with the same `benson-decision-routing-` prefix. The full old plan preserves their exact evidence and rollback details. Historical locations are an inventory, not a blanket retention requirement. Apply the bounded retention rule above to historical preservation wording throughout this plan; maintenance may retire superseded records/references only after confirming that no active acceptance, rollback, unresolved dependency or current canonical reference still requires them. Do not weaken current evidence or delete anything as part of routing implementation.

## 3. Stage execution rules and design decisions

Every changing stage follows **Inspect → Decide → Backup → Patch/Rewrite → Validate → Acceptance → Snapshot**. S01 is inspection/decision only. Dependencies mean accepted evidence, not merely files present.

**Root engineering-contract prerequisite (before S01, outside S01):** before any dependent Sol implementation session, checkpoint and correct only the stale architecture-boundary wording in `/home/oa/projects/benson/AGENTS.md` to match the approved architecture: Main is the central cognitive orchestrator; deterministic Request/Completion/Response control owns the respective boundaries, and Response Controller is the interactive outbound boundary. Preserve all other engineering rules and distinguish target architecture from active runtime. Do not change `main/AGENTS.md`, domain runtime AGENTS, config, tools or loading behavior, and enable no production behavior. Acceptance requires a focused root-only diff, architecture comparison and unchanged runtime-owner/config hashes; rollback restores only the root contract from its verified checkpoint. Record acceptance here before handing off S01. Recheck the Section 2 loading evidence if workspace/bootstrap ownership changes; if root becomes runtime-loaded, stop this early change and keep it under S15/S17 instead. This is a planned documentation prerequisite, not work performed by this amendment.

- Source checkpoint C: for canonical source, documentation and tests, use the verified pre-change Git commit/branch as the restorable checkpoint; inspect the focused diff before commit and preserve accepted history. Do not duplicate Git-managed source into `output/checkpoints/`. Runtime/configuration/state/package artifacts that Git cannot safely restore use checkpoint R below.
- Runtime checkpoint R adds package/build, active non-secret config, plugin/patch versions and supported native state/migration recovery. Use approved protected backup mechanisms for sensitive state; no raw secrets in plan artifacts. Prove restore compatibility before exposure.
- Validation commands below are future commands, not claims of existing tests. Extend existing test owners where appropriate; proposed test files are private tests, not new runtime surfaces. Native adapter tests must exercise the selected installed implementation, not merely a simulated state machine.
- Runtime exposure stays disabled through S14. Only the verified non-runtime root engineering-contract prerequisite occurs earlier; active Main/domain runtime AGENTS and config remain staged for S15/S17 publication. One ready batch normally has one reload; validate config using the installed documented command before exposure.
- After meaningful accepted code/contract/runtime changes, run and verify `bensonsnap` under project rules. No snapshot for a plan-only ledger update or preparation-only intermediary. Record snapshot query failures honestly.
- Rollback B: disable affected behavior for new admissions through the verified native control, preserve/drain committed work and delivery recovery, reconcile uncertain effects, then restore compatible canonical source from Git and runtime/configuration/state/package artifacts from the applicable verified runtime checkpoint. Never remove operation/idempotency history or replay an admission. Physical actions and delivered messages cannot be undone by file restoration.
- Initial contract design: common TaskResultEnvelope status retains success/clarification_required/failure and versioned domain data; ResponseEnvelope adds explicit partial and not-applicable execution semantics. S02 fixes encoding and bounded limits. Trust fields come from native control, not deserialized model claims.
- Response truth design: operational statements come from reviewed templates with authoritative fact references. All material results/warnings/errors/partial effects and dates/times must be covered. Arbitrary prose cannot be proven truthful by JSON validation, keyword matching or a second LLM. S09/S10 admit only enforceable rendering contracts; unsupported prose uses bounded safe response handling.
- Main-only conversation has an explicit no-domain-results contract, not fabricated execution verification. Main's optional conversational/creative candidate remains distinct from operational facts. Mixed-domain creative content must not smuggle new execution claims; use an enforceable reviewed composition or reject that candidate. The required joke can use a reviewed creative fragment; no renderer is allowed to invent domain success.
- Decision disabled/unavailable/invalid selects Main only before commitment. A cancelled native admission remains cancelled. Post-dispatch/accepted/uncertain state retains its owner and recovery; no original-request fallback through Main.

## 4. Ordered implementation stages

### S01 — Native capability and ownership decision

- **Objective / invariant:** determine supported bindings for architecture Sections 3–7/10 without inventing APIs or a second state owner.
- **Dependencies:** implementation-plan approval and accepted root engineering-contract prerequisite from Section 3. **Owners:** this plan's capability/acceptance tables; installed OpenClaw source/docs; existing integration and patch owners.
- **Inspect:** exact running/deployed build, effective tool policies, admission identity and command ordering, isolated spawn/yield, cancellation/commitment durability, CALLER/direct completion, model access, restricted continuation, transcript and delivery ownership. Inspect only relevant source and patch application state.
- **Scope / production:** record symbol/path/version/support status and one minimal proving test specification per boundary; select reuse/extension and exact registration/config owner. No code, install, runtime change or provider call.
- **Checkpoint:** C for plan-only evidence updates; no package checkpoint until an approved upgrade is concrete.
- **Deterministic tests / validation:** read package version/exports and filtered config; use the installed CLI's documented read-only version/status and focused source checks. Expected: every capability is supported-with-evidence or an explicit gap with owning stage; no unsupported binding is marked ready.
- **Acceptance:** commit/recovery, completion destination and universal response interception have concrete native owners or recorded blockers. Decide whether current build suffices; if not, propose a specific stable upgrade and compatible restore.
- **Rollback:** restore only the plan evidence delta.
- **Stop / native dependency:** missing native authority blocks its dependent runtime work. Do not solve by hook timeout, generic Gateway agent invocation or private import.
- **Approval:** Oren must approve any new plugin/config surface, host modification, upgrade or architectural boundary; no additional approval for focused read-only mapping.

#### S01 decision record — 2026-09-25

**Observed baseline and limits.** The running systemd Gateway (PID 1169820, started 2026-09-25 11:08 IDT) executes /usr/bin/node /home/oa/.npm-global/lib/node_modules/openclaw/dist/index.js gateway --port 18789. The installed package, CLI, and successful openclaw gateway status --json --timeout 4000 RPC all report 2026.9.4; the inspected bundle files predate that process. The service unit display label says v2026.7.1-beta.6 and is stale version evidence. One earlier broad status probe timed out; the focused Gateway RPC succeeded. Non-secret config projection: WhatsApp account benson binds to Main; plugin load paths contain only Jessica and Reminder domain plugins; no Decision model is selected; Main permits those two child agent IDs; both domain agents have empty runtime skills, minimal tool profiles and deny direct message use. These are configured policies, not a live effective /tools proof. S01 invoked no request, provider, child run, device or delivery.

| Boundary | Installed 2026.9.4 evidence and binding decision | Owner and remaining gap |
| --- | --- | --- |
| Admission, identity, commands, cancellation | dist/dispatch-from-config-CmAXENud.mjs owns reply-operation admission, source-turn identity/dedupe, fast abort and approval commands, plugin-bound claims, before_dispatch, reply_dispatch and default agent dispatch. before_dispatch has canonical message ID and trusted channel/session context, but is a claiming hook; reply_dispatch is terminal takeover. dist/hook-runner-global-BhDCl4qm.mjs races claiming hooks against timeout, logs exceptions and can continue another/default path while timed-out work still runs. Neither is an exclusive commitment. Native command, internal completion, retry, cancelled/replaced turn and unsupported input must be classified before any Decision call. | Extend native reply admission with one trusted durable route commitment, or prove a supported upstream equivalent. integrations/openclaw/benson-routing/ remains pure policy/contract owner. Runtime blocker S03/S05. |
| Main spawn/yield and CALLER | dist/sessions-spawn-tool-2GiVSHqU.mjs owns sessions_spawn, sessions_yield, requester/child identities, accepted runId/child session and native completion. The installed yield acknowledgment patch preserves private resume context. Select this agent tool for Main-owned CALLER work; its internal spawnSubagentDirect is not an external import. | Native subagent lifecycle/session store owns Main-spawned work. S05/S06 must prove accepted-run durability, cancellation, one correlated result and fresh effective child policy. |
| Direct domain run and completion | Public plugin api.runtime.subagent.run (dist/agent-harness-runtime-BvaKEkqR.d.ts; dist/server-plugins-BgRb-rux.mjs) calls Gateway agent with an explicit sessionKey and returns runId. completionDelivery: current-requester binds only inside an active requester-bound hook. This is not sessions_spawn and does not prove fresh isolation, identical policy, RESPONSE_CONTROLLER destination or crash-safe handoff. waitForRun/getSessionMessages are not durable completion control. Jessica dist/completion.js:validateJessicaCompletion requires an agent:main: parent. | Native child/completion owner must supply or be extended for direct work; extend Jessica's canonical validator without weakening freshness. Runtime blocker S05/S06. |
| One-shot Decision and Response inference | Installed PluginRuntime.llm.complete supports execution.mode: isolated-agent-runtime, one user message, literal zero tools, timeout, abort signal and host-owned provider/harness selection. It is a supported candidate for narrow inference, subject to model/data approval and a proving test. plugin-sdk/simple-completion-runtime is documented private-local and is not selected. Installed 2026.9.4 has no PluginRuntime.decisions or configured Decision model. | OpenClaw model runtime owns credentials, lifecycle and cancellation; S04/S10 own evidence/output validation. Unavailable/disabled selects Main before commitment. No provider or data transfer is approved here. |
| Completion and restricted continuation | Native requester correlation exists for Main children. No inspected supported API establishes a direct trusted RESPONSE_CONTROLLER target or effective per-continuation denial of tool/spawn/mutation. The installed Main failure reconciliation patch preserves bounded child truth and forbids original-request replay; it is not Completion Control. | Extend native completion/continuation enforcement, the common envelope in benson-routing, Jessica truth and Reminder tool owners. Runtime blocker S06/S07/S11. |
| Universal response and delivery | dist/dispatch-from-config-CmAXENud.mjs, dist/chat-send-handler-oS9rX200.mjs and dist/deliver-prepare-DIjGg5Gi.mjs own final queues, assistant transcript receipts, originating-channel routing and physical delivery. reply_payload_sending sees normalized outbound payloads and can rewrite/cancel, but dist/hook-runner-global-BhDCl4qm.mjs catches timeout/error and continues with the prior payload. It has no authoritative ResponseEnvelope or guaranteed fail-closed coverage. Fast commands, native notifications and plugin-bound replies have distinct paths. Queued final or transcript receipt is not delivery proof. | Select a native interactive finalization gate before canonical assistant append/native delivery, with trusted source/correlation, fail-closed Benson policy and native delivery-only recovery. Runtime blocker S09/S17. |

**Design and approval boundary.** Installed 2026.9.4 is insufficient for the target control plane: no supported exclusive pre-Main commitment, direct native completion destination or universal fail-closed Response Controller gate was established. Plugin-only composition of before_dispatch, reply_dispatch and reply_payload_sending fails on timeout, late work, bypass paths and delivery authority; extending a domain plugin would put cross-domain control under a domain owner. Preferred design: a focused OpenClaw host/core extension at the existing reply admission, subagent completion and finalization owners, consuming pure integrations/openclaw/benson-routing/ modules. The version-bound implementation owner would be integrations/openclaw/patches/; re-resolve upstream source/exports for the chosen version. No second store, transport, public tool or agent is selected. This exact host change and any integration registration/config require Oren's concrete approval before implementation. A supported upstream equivalent may replace it after the same invariant proof. Do not import bundled private symbols.

**Release decision.** Installed 2026.9.4 lacks typed Decision runtime. The published stable [2026.9.6 release](https://github.com/openclaw/openclaw/releases/tag/v2026.9.6) adds optional Decision Models including TypeSafe Jev and local ONNX. [Decision documentation](https://docs.openclaw.ai/concepts/decision-models) describes plugin api.runtime.decisions.evaluate; [Decision assistance documentation](https://docs.openclaw.ai/concepts/experimental-features) says no automatic consumer is wired. This is an upgrade candidate for S04 provider support, not a proven remedy for commitment, direct completion or universal response. No upgrade is selected or authorized in S01. Before an approved upgrade, prepare R with compatible state/config restore, verify versioned patch equivalents including Main failure reconciliation and memory result admission, rerun focused regressions against the chosen package and prove affected native paths. No development build or private SDK import is a fallback.

**Minimum proving specifications for dependent stages (not tests run in S01).** Exercise the selected native implementation with native admission/run/session identities, never request-text equality:

| Boundary / stage | Minimal proving test |
| --- | --- |
| Admission and commitment, S03/S05 | Deliver two distinct identical-text external turns and one duplicate provider event; verify two independent admissions and one owner each, while the duplicate has one owner. Native commands/internal completions bypass classification. Cancellation, late classifier and crash around dispatch cannot create competing Main/domain runs; inspect durable acceptance before retry. |
| Model binding, S04/S10 | With an approved test provider, call installed isolated zero-tool llm.complete through selected binding using bounded input, signal and timeout; assert no callable tools/history, lifecycle/cancellation, unavailable versus invalid result and Main-only pre-commit fallback. If upgraded, prove decisions.evaluate and score semantics on that exact release separately. |
| Fresh execution and destinations, S05/S06 | Spawn one Main child through sessions_spawn and one direct child through selected native owner; assert fresh session, effective allowlist parity, durable runId, trusted CALLER versus RESPONSE_CONTROLLER destination, lost acknowledgment recovery and no alternate owner or replay. |
| Completion and restricted continuation, S06/S07/S11 | Inject valid, stale, duplicate, foreign, contradictory and forged result/destination shapes into native completion; only one correlated valid result advances its trusted destination. Response-only Main continuation attempting tool/spawn/message/mutation is denied by native policy and cannot loop. |
| Finalization and delivery, S09/S17 | For Main-only, Main+child, direct, clarification and truthful failure turns, including eligible normal channel/progress and plugin-bound paths, prove every Benson interactive final crosses Response Controller exactly once. Force renderer rejection, hook failure, transcript failure, send failure and restart; assert one canonical final and native delivery or durable delivery-only recovery with zero domain replay. |

**S01 acceptance evidence.** Focused installed-source inspection and non-secret config projection completed; live Gateway RPC reported 2026.9.4 with no plugin version drift. All four version-bound patch regressions passed with required installed source arguments: Main failure reconciliation, memory owner-diagnostic admission, question lifecycle admission and sessions_yield acknowledgment. The first invocation of the memory and question tests omitted required path arguments; after correcting that harness input, both passed. This is the S01 ownership decision with explicit runtime blockers. It does not claim a working fast path, effective live policies, provider readiness or production E2E.

### S02 — Shared versioned contracts

- **Objective / invariant:** establish one common contract owner separating request, model evidence, execution authority, completion and response.
- **Dependencies:** S01 ownership decision; missing native integration does not block pure schema work.
- **Owners / inspect:** `envelope.mjs`, `classification.mjs`, domain result/Reminder contract owners and their existing fixtures; inspect actual field meanings and version compatibility.
- **Scope / production:** define exact encoding for ExecutionRoute/CompletionRoute as trusted control metadata, TaskResultEnvelope, ResponseEnvelope and bounded rendered output. Fix null/absent rules, common/domain versions, per-result status/task links, explicit not-applicable verification, pending-context binding/expiry, collection/text limits and unknown-version failure. No active runtime exposure or new store.
- **Checkpoint:** C for contract/test files.
- **Deterministic tests / validation:** `node --test integrations/openclaw/benson-routing/tests/contracts.test.mjs` (new) plus affected routing tests; expect strict validation, lossless legacy normalization and rejected model-authored authority.
- **Acceptance:** legacy Jessica and Reminder facts survive a single reviewed migration; aggregated partial results cannot validate as all-success; trusted fields cannot be supplied through ordinary model payloads.
- **Rollback:** restore C; no domain state conversion required while unregistered.
- **Stop / native dependency:** native IDs remain opaque references; do not invent receipts, new handoff IDs or persistent schemas. Unknown domain semantics go to the domain owner.
- **Approval:** approval of this plan covers private contract definitions; a new public tool/config/state surface requires separate approval.

### S03 — Request Controller admission boundary

- **Objective / invariant:** identify each new admitted external interactive request before Main; preserve exact request and native authority.
- **Dependencies:** S01/S02; supported admission binding required for integration tests.
- **Owners / inspect:** `envelope.mjs`, `policy.mjs`, focused new private `request-control.mjs` only if needed within the existing routing owner; S01-selected native admission consumer. Inspect new/retry/internal/cancelled event identity and all active input types.
- **Scope / production:** bounded input extraction/projection; distinguish external turns, duplicate admissions, internal completions, recovery and scheduled events; preserve command/permission/cancellation handling. Wire disabled path only in isolated tests.
- **Checkpoint:** C; R only if approved native code must change. Production unchanged.
- **Deterministic tests / validation:** `node --test integrations/openclaw/benson-routing/tests/request-control.test.mjs`; expect exact Unicode/whitespace round-trip, rejection of forged runtime context, two identical-text new turns retained, same-admission retry deduped, no internal reclassification.
- **Acceptance:** every interactive ingress is mapped or explicitly blocked; unsupported input remains Main-eligible through normal native admission, not classifier data leakage.
- **Rollback:** restore C/R; retain native admission history.
- **Stop / native dependency:** no reliable new-admission identity/order, or any classifier projection requires hidden history/credentials.
- **Approval:** exact host/registration changes must already be approved from S01; no runtime enablement here.

### S04 — Provider-independent Decision binding

- **Objective / invariant:** bounded untrusted classification evidence; unavailable provider leaves Main usable.
- **Dependencies:** S02/S03 and an S01-verified supported one-shot binding.
- **Owners / inspect:** `classification.mjs`, `rubric.json`, existing native model/provider owner. Verify installed wire schema, deadline/cancellation, supported question types, confidence meaning and privacy limits.
- **Scope / production:** map only observed provider evidence; retain unavailable outcome, explicit unknowns and approved rubric. No custom Jev API, synthetic production provider, assumed calibrated confidence or forced missing flags. If unsupported, retain unavailable implementation and mark real binding blocked.
- **Checkpoint:** C; protected R for later separately approved provider configuration. No production activation.
- **Deterministic tests / validation:** extend `tests/routing.test.mjs`; `node --test integrations/openclaw/benson-routing/tests/routing.test.mjs` expects missing/revoked credentials, timeout, rate limit, malformed/oversized/unsupported results to select Main before commitment; cancelled/late work cannot dispatch.
- **Acceptance:** provider-independent contract works without provider access; real binding acceptance additionally needs supported installed evidence. Neither conditional success nor a successful Main label is fabricated.
- **Rollback:** restore C; disable only new model binding, preserving ordinary Main.
- **Stop / native dependency:** unsupported invocation/auth surface or unsettled evidence semantics; this blocks fast path, not other pure preparation.
- **Approval:** Oren approves provider/model and household-data handling before any external inference; credentials use supported native setup only.

### S05 — Deterministic routing and exclusive commitment

- **Objective / invariant:** exactly one initial owner per admission and one owner per child task, including crash/timeout races.
- **Dependencies:** S02–S04 plus S01 native durable commitment/recovery proof.
- **Owners / inspect:** `policy.mjs`, request-control consumer, native admission/spawn/cancellation owners. Inspect receipt durability and authoritative absence versus unknown acceptance.
- **Scope / production:** policy consumes validated evidence plus trusted eligibility; commit Main or a fresh isolated domain, set trusted CompletionRoute, then dispatch through supported native lifecycle. Preserve domain allowlists. Post-commit failure reconciles owner; never redispatch original request through Main.
- **Checkpoint:** C/R as affected; tests/staged binding only, production fast paths off.
- **Deterministic tests / validation:** `node --test integrations/openclaw/benson-routing/tests/commitment.test.mjs`; exercise native implementation at before/after commit, lost acceptance, late classifier, concurrent retry, cancellation, session replacement and restart boundaries.
- **Acceptance:** one native owner/accepted child at most for each admission; real distinct admissions remain distinct. Lifecycle booleans alone cannot pass. No direct eligibility unless completion/response capability is approved.
- **Rollback:** B plus C/R restore; retain accepted-child records.
- **Stop / native dependency:** unresolved ownership, unsupported direct isolated spawn or restart recovery; do not add a compensating custom ledger.
- **Approval:** no direct mutations authorized by policy-test success; runtime activation waits for S17.

### S06 — Domain TaskResultEnvelope adapters

- **Objective / invariant:** structured facts retain domain truth, operation state, warnings and provenance across Main and direct routes.
- **Dependencies:** S02; use S05 native correlations when integration-testing adapters.
- **Owners / inspect:** Jessica `lib/results.mjs` and plugin `dist/completion.js`; Reminder plugin contracts/runner and `libexec/reminder-service-core`; both domain AGENTS staged for S15. Inspect real result shapes, tool truth and clarification provenance.
- **Scope / production:** extend canonical validators with common/domain versions and optional candidate text; bind supplied provenance to trusted evidence. Extend Jessica's Main-only correlation for supported direct ownership without deleting freshness checks. Preserve Reminder full-list, atomic transaction, Calendar and route-bound pending-context semantics.
- **Checkpoint:** C for exact affected owners; R if a domain output change must be exposed, deferred to the ready rollout batch.
- **Deterministic tests / validation:** contracts test plus `node --test integrations/openclaw/plugins/benson-jessica-tool/tests/completion.test.mjs`; run `bash agents/reminder-service/tests/test-v3-contract.sh` once when its result surface changes. Expect tool/result equality, exact pending context, full collections and forged/stale result rejection.
- **Acceptance:** both domains normalize without loss; accepted/started/completed remain distinct; candidate text and `verified:true` cannot create evidence.
- **Rollback:** restore compatible adapters from C; preserve domain operation history. No state back-migration.
- **Stop / native dependency:** direct route lacks authenticated conversation binding, Reminder continuity cannot be preserved, or completion fact is unavailable; keep that route disabled.
- **Approval:** domain capability expansion is separate; current result-contract adaptation is within this plan.

### S07 — Completion Control and Main caller continuation

- **Objective / invariant:** validated completion follows trusted CALLER or RESPONSE_CONTROLLER exactly once.
- **Dependencies:** S05/S06 and native completion/continuation ownership from S01.
- **Owners / inspect:** existing domain completion validators and native child/result continuation; private routing `completion-control.mjs` if needed for policy. Inspect retained child results, truncation, task/caller IDs and native recovery.
- **Scope / production:** validate ownership/schema/tool provenance/current admission; reject contradictory or duplicate completion; route structured results to Main caller or deterministic direct normalization. Preserve one bounded native result read for malformed completion where supported, never task replay. Do not let result payload choose recipient/policy.
- **Checkpoint:** C/R for staged owner changes; production exposure off.
- **Deterministic tests / validation:** `node --test integrations/openclaw/benson-routing/tests/completion-control.test.mjs` and affected Jessica completion test. Expect both destinations, duplicate suppression, stale/wrong-parent rejection and bounded malformed-result recovery.
- **Acceptance:** Main resumes only for its committed child; direct completion requires no Main wrapper. Unknown side effects retain recovery; invalid results neither advance dependencies nor produce success.
- **Rollback:** B; drain native in-flight completion under compatible contracts before restore.
- **Stop / native dependency:** no supported direct destination, unsafe automatic child announcement or loss of caller/turn correlation. No alternate completion transport/store.
- **Approval:** no new completion service; any required boundary change returns to Oren.

### S08 — ResponseEnvelope normalization and Main finalization

- **Objective / invariant:** every finished workflow exposes authoritative results independently of proposed wording.
- **Dependencies:** S02/S07.
- **Owners / inspect:** `envelope.mjs`, Completion Control and S01-selected Main finalization boundary; inspect Main-only, direct, partial, clarification and error shapes.
- **Scope / production:** normalize one direct result deterministically; validate Main result aggregation and attach trusted source/request/provenance/response policy. Preserve per-result task/version/status links and explicit no-domain-results semantics. Stage Main instruction changes for S15.
- **Checkpoint:** C; no active runtime change.
- **Deterministic tests / validation:** `node --test integrations/openclaw/benson-routing/tests/contracts.test.mjs integrations/openclaw/benson-routing/tests/response-envelope.test.mjs`; expect lossless warnings/errors/times/pendingContext and rejected all-success summaries of partial outcomes.
- **Acceptance:** Main-only, direct and arbitrary bounded multi-result collections share one contract; missing candidates are valid; Main cannot author trusted response modes or correlated=true.
- **Rollback:** restore C, keeping in-flight contract compatibility.
- **Stop / native dependency:** finalization cannot preserve the owning native conversation, or important facts exist only in prose.
- **Approval:** no additional gate for pure implementation; exposure waits for S17.

### S09 — Response Controller, renderer and pass-through

- **Objective / invariant:** single interactive outbound boundary; truthful output and native finalization without execution replay.
- **Dependencies:** S08 and S01-supported finalization/delivery boundary.
- **Owners / inspect:** `presentation.mjs`, private `response-control.mjs` within routing if needed, canonical date formatter and native reply/delivery owners. Inspect all Main/direct success, clarification, infrastructure failure and progress paths.
- **Scope / production:** enforce trusted mode eligibility; PASS_THROUGH only under reviewed fact/coverage validation, DETERMINISTIC_RENDER for supported versioned shapes. Bind final transcript/delivery once; block raw tool/domain JSON and unvalidated progress/commentary from bypassing the interactive boundary. Scheduled notifications remain separate.
- **Checkpoint:** C/R for staged changes; no production cutover.
- **Deterministic tests / validation:** `node --test integrations/openclaw/benson-routing/tests/presentation.test.mjs integrations/openclaw/benson-routing/tests/response-control.test.mjs`; expect existing goldens plus warning/partial preservation, unknown-shape rejection, accepted-not-completed wording, exact times, duplicate finalization and native delivery-only retry.
- **Acceptance:** all interactive finals converge here; a queued response is not counted delivered. PASS_THROUGH presence/schema alone is insufficient. Unsupported rendering yields an approved truthful fallback with no repeated execution.
- **Rollback:** B plus compatible C/R restoration; pending native delivery keeps ownership.
- **Stop / native dependency:** any uncontrolled interactive egress, no native transcript/delivery correlation, or localization needs a duplicate formatter. Reuse a supported canonical formatter invocation or obtain approval for a minimal extraction at that owner.
- **Approval:** approve reviewed rendering/composition contracts and any formatter-owner change before runtime exposure; no custom outbound dispatcher.

### S10 — One-shot Response Model and factual guardrails

- **Objective / invariant:** stateless wording assistance cannot change execution truth, hide facts or gain tools.
- **Dependencies:** S02/S09; supported native tool-free one-shot model binding from S01.
- **Owners / inspect:** `presentation.mjs`, Response Controller, existing native model owner and presentation fixtures. Inspect supported structured-output bounds and privacy.
- **Scope / production:** implement ONE_SHOT_RESPONSE_MODEL with one bounded call and no conversation/session memory, tools, mutation, retries or delivery authority. Project only allowed facts, limits, language, warnings/errors and clarification. Model proposes a constrained render plan or text matching a reviewed finite grammar; controller resolves fact references and inserts immutable authoritative values.
- **Checkpoint:** C; model configuration uses R only in an approved deployment batch. Production mode remains disabled.
- **Deterministic tests / validation:** `node --test integrations/openclaw/benson-routing/tests/response-model.test.mjs`; adversarial outputs attempt failure-to-success, removed warnings, altered dates, completion from acceptance, fabricated facts, injected IDs, excessive text, tools and malicious templates. Expect rejection and zero execution calls.
- **Acceptance:** required-fact coverage is checked independently of model output; template vocabulary/state permissions prevent stronger claims. Numeric/date equality alone is insufficient. Unconstrained operational prose is rejected. Model failure/timeout falls back to approved deterministic response; broader semantics only via S11.
- **Rollback:** disable this response mode, retain renderer/pass-through for valid contracts and truthful safe failure; restore C without touching completed operations.
- **Stop / native dependency:** inability to enforce no tools/hidden context, unsupported model binding or unconstrained prose truth requirement. Leave the mode unavailable rather than accepting a prompt promise.
- **Approval:** provider/model, data egress and concrete render grammar/coverage contracts require Oren review before activation; no new agent.

### S11 — Restricted Main result continuation

- **Objective / invariant:** broader semantic response work consumes completed results without mutation, replay or response loops.
- **Dependencies:** S07–S10; S01-supported restricted native invocation.
- **Owners / inspect:** native Main continuation/tool-policy owner, Response Controller and staged `main/AGENTS.md`; inspect effective per-run restriction and all alternative execution/communication surfaces.
- **Scope / production:** pass already validated results with minimum relevant context; deny domain tools, spawn/send, shell, scheduler, generic network mutation and direct user delivery at the effective capability boundary. Allow at most one response-only Main continuation per response lifecycle; preserve this budget across recovery in existing native state.
- **Checkpoint:** C/R for staged changes; production unaffected.
- **Deterministic tests / validation:** `node --test integrations/openclaw/benson-routing/tests/response-continuation.test.mjs`; attempt replay, unrelated child, forged budget reset, repeated callback and restart. Expect capability denial, at most one continuation and return to Response Controller.
- **Acceptance:** no domain invocation is possible through any exposed alternative; exhausted/unsupported continuation yields an approved truthful response, never the original request as a fresh task.
- **Rollback:** disable continuation and restore C/R; keep native response/delivery recovery and completed facts.
- **Stop / native dependency:** no enforceable per-run restriction or durable finite budget. Keep optional continuation disabled; do not add a separate agent/store to bypass the gap.
- **Approval:** concrete restrictions/budget reviewed with the plan; new native policy surface or architectural boundary needs separate approval.

### S12 — Independent multi-domain orchestration

- **Objective / invariant:** Main owns one workflow, independent children own distinct tasks, partial truth survives aggregation.
- **Dependencies:** S05–S09; S11 only when response-only escalation is used.
- **Owners / inspect:** staged Main contract, native spawn/yield/caller continuation, shared envelope and response validators. Inspect bounded fan-out, identity and result retention.
- **Scope / production:** Main projects minimum sufficient briefs for independent Jessica and Reminder children; trusted completion routes are CALLER. Correlate a bounded collection by native task identity, aggregate every terminal outcome and a safe conversational component. Persist required waiting/dependency facts in existing native lifecycle, not hidden Main memory.
- **Checkpoint:** C/R for staged native changes; no production enablement.
- **Deterministic tests / validation:** `node --test integrations/openclaw/benson-routing/tests/orchestration.test.mjs`; cover one, two and larger bounded child sets, out-of-order/duplicate completion, one failure, clarification, cancellation and missing result.
- **Acceptance:** no hard-coded two-result logic; each child has one owner, authorization and result link; success plus failure is partial; no result omission or duplicate mutation. Final output passes Response Controller.
- **Rollback:** B and C/R restore after child reconciliation; never restart successful children to rebuild aggregation.
- **Stop / native dependency:** no native restart-safe waiting/correlation, unresolved references/authorization, or a purportedly independent task actually depends on another.
- **Approval:** no new orchestrator/store; physical and Reminder canaries require S17's explicit authorization.

### S13 — Deterministic conditional cross-domain gate

- **Objective / invariant:** dependent Reminder mutation occurs only after correlated verified Jessica completion.
- **Dependencies:** S12 and domain-owned exact task-completion capability. Inspect [Jessica capability plan](agents/jessica-vacuum/FULL_CAPABILITY_PLAN.md) for its accepted completion evidence; current planning evidence says unavailable.
- **Owners / inspect:** existing Jessica result/operation owner, native workflow dependency state and Reminder deterministic mutation boundary. Inspect native support for binding an enforced dependency to the downstream execution without an agent-authored token.
- **Scope / production:** enforce predicate `status == success && verified == true && domain-versioned facts prove this cleaning task completed successfully`. Failures, started/accepted, unrelated completed task, stale sensor, docked, timeout or missing proof do not pass. Main selects dependency semantics; deterministic native control and the downstream boundary enforce them.
- **Checkpoint:** C/R for affected owners. No production activation; no domain completion feature silently added here.
- **Deterministic tests / validation:** extend `tests/orchestration.test.mjs`; table-driven predicate tests and attempted direct Reminder bypass; duplicate completion/restart must release the dependent task at most once. Expected: zero Reminder mutations for every false/unknown predicate.
- **Acceptance:** real correlated completion releases one authorized Reminder task; pending waits use approved durable native/domain completion and bounded recovery without keeping an LLM alive. Reminder resolves time semantics from trusted time and grounded intent; ambiguous reference point requires clarification.
- **Rollback:** B; cancel only still-uncommitted dependent work through native authority. Inspect any already-created Reminder and use approved cleanup, never restore a stale scheduler snapshot.
- **Stop / native dependency:** exact completion, durable event/resume or mutation-boundary enforcement missing. Mark positive conditional E2E BLOCKED; negative no-reminder acceptance alone is insufficient. No timing guess, model polling or new task database.
- **Approval:** Oren resolves any domain capability work or new native authority/configuration surface in its canonical owner before this gate can activate.

### S14 — End-to-end observability

- **Objective / invariant:** make ownership, truth, inference cost and final delivery independently auditable without sensitive content.
- **Dependencies:** S03–S13 contracts; unavailable optional capabilities are recorded explicitly.
- **Owners / inspect:** `telemetry.mjs`, `evaluation.mjs` and existing native diagnostics/audit. Inspect available trusted IDs, monotonic clocks, model usage and delivery outcomes.
- **Scope / production:** implement Section 6 trace/metrics, privacy-safe export and missing-value semantics through existing observability. Instrument stages at their owners; no new logging service, ledger or dashboard.
- **Checkpoint:** C/R as affected; staged only.
- **Deterministic tests / validation:** `node --test integrations/openclaw/benson-routing/tests/telemetry.test.mjs integrations/openclaw/benson-routing/tests/evaluation.test.mjs`; expect joined native identities, redaction, explicit unknown usage, correct denominators and no fabricated savings.
- **Acceptance:** fixture and isolated native traces distinguish Main bypass, pre-commit fallback, response-only Main, uncertain effects and delivery recovery. Every missing observation is unavailable, not zero.
- **Rollback:** restore instrumentation/config delta; preserve native execution/delivery history.
- **Stop / native dependency:** tracing requires raw secrets/content or duplicates state ownership; unavailable metrics cannot count as measured acceptance.
- **Approval:** approve only necessary household trace sampling/retention before live collection.

### S15 — AGENTS and runtime-contract alignment readiness

- **Objective / invariant:** instructions, effective permissions and implemented control boundaries agree before activation.
- **Dependencies:** S06–S14 accepted for enabled capabilities; explicit disabled disposition for optional gaps.
- **Owners / inspect:** `main/AGENTS.md`, both domain runtime AGENTS, actual OpenClaw config and S01-selected registration owner; check consistency with the already aligned root engineering contract. Inspect only changed runtime-contract sections and effective allowlists.
- **Scope / production:** prepare one coherent deployment delta: Main submits ResponseEnvelope; domains return TaskResultEnvelope through trusted destinations; neither owns interactive delivery. Preserve Main contextual reasoning, child isolation, zero domain skills, freshness, Reminder pending provenance, date policy and scheduled-notification separation.
- **Checkpoint:** C/R. Prepare staged contract/config bytes with recorded canonical destinations; active runtime AGENTS/config publication is deferred to S17. The accepted pre-S01 root-only alignment does not authorize earlier runtime publication.
- **Deterministic tests / validation:** targeted contract assertions and installed documented config validation against the staged configuration. Expected: no instructions referring to absent capabilities, no broadened tools, no retired TOOLS dependency and no direct message bypass.
- **Acceptance:** deployment manifest lists exact files, permissions, feature defaults, rollback compatibility and one planned reload; existing Main/domain behavior has explicit preservation checks.
- **Rollback:** discard only this stage's unexposed candidates or restore its C; leave active accepted contracts intact.
- **Stop / native dependency:** contract requires unavailable enforcement; root/Main/domain policy conflict or exposure would precede safety/response readiness.
- **Approval:** Oren reviews concrete configuration/registration/permission delta; approval of architecture alone does not approve a new surface.

### S16 — Real model evaluation and shadow

- **Objective / invariant:** measure eligibility and response quality while Main remains sole initial execution owner.
- **Dependencies:** S04/S14/S15 plus supported observational binding and approved provider/data access. No direct execution.
- **Owners / inspect:** reviewed rubric/corpora, `evaluation.mjs`, native provider and admission consumer. Inspect model/version, data terms, actual score semantics, held-out isolation and observation budgets.
- **Scope / production:** evaluate real labeled samples; freeze held-out groups before tuning. Then enable bounded shadow evidence only through the approved native consumer, always retaining Main ownership. Shadow is a real privacy/cost/latency change even though it cannot dispatch.
- **Checkpoint:** R for observational activation; preserve off/default configuration.
- **Deterministic tests / validation:** routing/evaluation tests plus deterministic comparison of labeled provider observations and native shadow traces. Expected: zero classifier-owned execution, no second child, measured availability/latency/cost and response constraint failures.
- **Acceptance:** Oren approves versioned thresholds, error tolerance/confidence bounds, sample size by risk/language/context slice, deadline, total cost/latency budget and cohort. Missing numeric choices block rollout. Main's choices alone are not eligibility ground truth.
- **Rollback:** turn shadow off for new admissions; no shadow-owned domain actions should exist; retain ordinary Main/native recovery.
- **Stop / native dependency:** unsafe consumer attachment, privacy violation, drift, false fast path beyond reviewed limit or insufficient samples. No activation justified by synthetic tests.
- **Approval:** provider/household egress, sampling and measured rollout thresholds required. If no supported provider exists, this stage is BLOCKED and Main continues normally.

### S17 — Controlled runtime rollout and production canaries

- **Objective / invariant:** expose only fully verified bindings/contracts; direct mutation is never enabled by classifier accuracy alone.
- **Dependencies:** S01–S16 acceptance for the proposed cohort; S13 positive capability required before conditional workflow activation. Optional S11 may remain disabled with safe fallback; all three response modes need reviewed contracts, and unavailable model mode is recorded.
- **Owners / inspect:** S15 deployment manifest, native config/registration, all affected canonical contracts and domain canary verifiers. Preflight active work, domain capability/identity, rollback compatibility, exact room/time/recipient and native delivery health.
- **Scope / production:** publish ready contracts/bindings with config validation and one reload. First prove Main-only Response Controller path with Decision off, then context routes and read-only direct Jessica. Widen only one approved cohort/domain at a time; mutations require deterministic domain restrictions at the execution boundary, never router parsing of operation intent.
- **Checkpoint:** verified R and cleanup inventory before exposure; if an upgrade was approved, prove both retained patch invariants and existing domain E2E before fast-path enablement.
- **Deterministic tests / validation:** run affected suites once for the ready batch; execute Section 7 human canaries followed by correlated native/backend assertions. Expected: one owner, truthful structured result, correct response mode, final transcript plus delivery outcome; no competing Main/direct execution.
- **Acceptance:** positive direct Jessica has zero Main inference; context route uses Main; approved Main-domain behavior and notification semantics remain intact. Record real calls/tokens/cost/latency, cleanup and snapshot. Do not claim full acceptance with blocked conditional or response capability.
- **Rollback:** B and compatible R restore. New requests may use Main; accepted direct work remains owned until completed/reconciled. Cleanup only verified test-created Reminder/Calendar resources; physical work requires approved domain control.
- **Stop / native dependency:** any duplicate mutation, false success, bypassed controller, lost warning/time, uncorrelated completion, unsafe continuation or unknown delivery ownership.
- **Approval:** Oren authorizes activation cohort and exact physical/Reminder canaries; real user interaction precedes backend verification. Canary cleanup is approved in the same handoff.

### S18 — Final E2E acceptance and handoff

- **Objective / invariant:** prove the full approved architecture, not merely isolated tests or configuration.
- **Dependencies:** S17 plus every mandatory flow/capability accepted; no silent waiver of unavailable direct path or exact completion.
- **Owners / inspect:** this plan acceptance ledger, canonical runtime owners, native audit and domain verification. Inspect delta since accepted canaries; reuse still-valid evidence instead of repeating it.
- **Scope / production:** close Section 7 acceptance with one evidence set per equivalence class, independent identity/permission proofs and negative injection in isolated native tests. Repeat production E2E only for affected/unproven behavior.
- **Checkpoint:** R before any remaining authorized canary/cleanup mutation; no new checkpoint for read-only evidence review.
- **Deterministic tests / validation:** assertion review joins admission through native delivery and checks Section 8 coverage. Expected: all required flow/negative rows PASS, no test artifacts/pending delivery, active contracts match config and fresh valid snapshot.
- **Acceptance:** concise ledger contains exact versions, checkpoints, test results, native correlations, Oren-visible observations, cleanup, final state and measured budgets. An unresolved mandatory row keeps overall status incomplete.
- **Rollback:** B only if regression warrants it; otherwise restore no runtime state for a documentation correction.
- **Stop / native dependency:** any missing proof, unverified physical completion, unresolved side effect or unsupported host dependency.
- **Approval:** Oren accepts representative real-user behavior; then record validated acceptance and stop this objective.

## 5. Dependency order and approval gates

Recommended execution order: root engineering-contract prerequisite (Section 3) → S01 → S02 → S03 → S04 → S05 → S06 → S07 → S08 → S09 → S10 → S11 → S12 → S13 → S14 → S15 → S16 → S17 → S18.

Pure S02/S06/S08/S09 contract work may proceed after its stated dependencies when a provider is unavailable. A blocked optional capability is explicitly disabled, not marked implemented. S13's domain prerequisite may progress only in the existing Jessica capability owner with appropriate approval. Do not rewrite the plan's dependencies during implementation; return a material change for review.

Conditional host-upgrade gate, owned by S01 and executed only as an explicitly approved prerequisite to the affected stage: identify a qualifying stable package, exact support evidence, migration-compatible R, patch equivalence and minimum affected E2E. Preserve `openclaw-2026.9.4-main-failure-reconciliation.patch` plus its `.test.mjs` invariant (bounded safe failure, preserved child truth, no replay) and `openclaw-2026.9.4-memory-tool-result-admission.patch` plus its test invariant (owner-only diagnostics excluded while useful facts survive). Reverify actual applied state and current test entry points; never carry a version-bound diff blindly. Stop for incompatible rollback or unsupported development-only API.

Oren decisions still required before dependent execution:

1. Approve this implementation plan and S01's concrete native binding/owner decision; any new plugin/config/host boundary or upgrade needs its own concrete approval.
2. Select supported Decision and optional Response providers/models with approved data handling. Jev access is unknown; no access or privacy approval is inferred.
3. Approve concrete response grammars, candidate/composition coverage and any canonical date formatter extraction. No arbitrary-prose truth guarantee is promised.
4. Resolve Jessica exact-completion capability and durable dependency enforcement before positive conditional E2E.
5. Accept measured policy thresholds, samples, deadlines, privacy-safe observability budgets and rollout cohorts.
6. Authorize the exact production physical/Reminder actions and their cleanup.

**Before the first dependent Sol implementation session:** accept the root-only engineering-contract prerequisite in Section 3. **First numbered Sol stage: S01 only.** Read the architecture's relevant boundaries and this evidence delta; map the installed native owners and gaps; record exact supported bindings/required decisions in this plan. Do not upgrade, register a plugin, call providers, implement controllers or change runtime as part of S01. Acceptance is a reviewable native capability decision and test specifications, not a working fast path.

## 6. Observability and evaluation contract

Trace using native identities:

`admission → classification evidence/policy → committed execution owner → agent/tool → verification → TaskResultEnvelope → Completion Control → caller or Response Controller → ResponseEnvelope/mode → final assistant message → native delivery/recovery`.

Carry policy/rubric/contract/model versions, input-type eligibility and route reason; execution owner and trusted completion destination; child/caller/task correlations; result schema, verification scope and partial effects; response mode, rejection/fallback, continuation count; native final message and delivery outcome/recovery owner. Keep model/tool diagnostics owner-only and sensitive raw requests/results out of routine telemetry.

Measure actual calls, tokens, cost where supplied, classification/domain/continuation/response/delivery latency and end-to-end latency. Unavailable usage is null/unknown, never zero. Report:

- Main bypass: eligible delivered workflows with no Main calls / applicable delivered interactive workflows; count response-only Main against zero-Main claims.
- Pre-commit Main fallback: unavailable/invalid/ineligible classification dispositions / applicable new admissions, separated from explicit Main classification and disabled policy.
- False fast path: independently adjudicated ineligible direct selections / accepted direct selections; also / all labeled inputs. Report denominators, uncertainty and context/language/mutation slices. In shadow these are hypothetical selections, not executed bypass.
- Response fallback: rejected/unsupported proposed modes / evaluated responses, by failure reason; preserve unavailable versus invalid.
- Delivery success/recovery and duplicate/uncertain-operation counts by native admission, not request-text equality.

Reuse existing corpus/evaluator; no copied threshold logic. Real held-out/shadow observations set activation criteria. Synthetic counts establish arithmetic and invariants only. Provider score semantics remain explicit; do not calibrate an arbitrary confidence field as a probability.

## 7. Acceptance scenarios and cleanup

Every production canary has one handoff: preflight → exact substituted user text → expected visible response → deterministic backend assertions → Oren's physical observation where needed → cleanup → final state. Resolve verified room/recipient/time parameters immediately before execution. Record exact native admission/run/task identities privately; a text token labels cleanup resources, not execution identity.

Common assertions for every flow: one initial owner; fresh isolated domain children with unchanged effective permissions; trusted completion route and evidence; ResponseEnvelope truth; chosen response mode; one canonical final assistant message; native delivery success or explicit durable recovery. A positive delivered-flow acceptance requires actual delivery, not merely queued text. Check ordinary channel reply/progress paths for controller bypass.

| Flow | Exact future user action | Visible outcome | Required backend / negative proof | Cleanup |
| --- | --- | --- | --- | --- |
| F1 — simple direct Jessica | `Tell Jessica to clean [APPROVED_ROOM].` after a read-only direct status canary | State only what is verified, usually cleaning started, never finished from acceptance alone. | Decision/policy choose Jessica; exactly one isolated domain run; RESPONSE_CONTROLLER completion; authoritative tool truth; zero Main inference including response continuation; native final delivery. No expanded room/settings permissions. | Pre-authorized physical cleanup through approved domain control if needed; inspect current state before issuing it. |
| F2 — context-dependent Jessica | First `Which rooms can Jessica clean?`; then `Tell her to clean the first one you listed.` only after verifying the selected room is approved | Correct contextual interpretation, or clarification when not grounded. | Second request routes through Main; exact current text plus minimum quoted context; CALLER child completion; no self-contained direct path. Positive cleaning case requires approved physical action. | Same bounded physical cleanup; no repeated operation to repair wording. |
| F3 — independent domains plus conversation | `Tell Jessica to clean [APPROVED_ROOM], remind me at [SAFE_FUTURE_LOCAL_TIME] to say [TOKEN], and tell me a short joke.` | Separate truthful cleaning and Reminder outcomes plus safe conversational content; partial failure remains explicit. | Main owns workflow; independent fresh Jessica/Reminder children may run concurrently with CALLER routes. Verify exact Reminder/Automation/time/recipient; aggregate all results through Response Controller. Fault variant in isolated native test makes one child fail and retains the other success. | Delete only the verified test Reminder and linked Calendar resources if any through existing domain tools; verify no leftover scheduled delivery. Physical cleanup as approved. |
| F4 — conditional domains | `Tell Jessica to clean [APPROVED_ROOM], and only if she finished successfully, create a reminder for one hour after verified completion saying [TOKEN].` | No Reminder while only started; create it only on verified successful completion; otherwise explain non-creation truthfully. | Main → Jessica → trusted completion → deterministic predicate → at most one Reminder task. Real domain-correlated completion required. Reminder owns schedule calculation. Also test the architecture's original `in one hour` wording: clarify if reference point is ambiguous. | Verify zero Reminder before gate; delete the one verified test Reminder afterward, preserving native operation history. Stop if completion capability is unavailable. |
| F5 — Main-only / clarification | `What is 17 times 3?`; then a reviewed ambiguous Reminder request and its answer | `51` via controller; clarification and continuation preserve exact pending context. | No fake domain facts for Main-only; clarification answer is a new context-dependent admission to Main. No internal completion creates a question or consumes an unrelated user's turn. | Clear only test-owned expired/terminal pending state through native mechanisms. |
| F6 — response modes | Reuse accepted direct/Main result canaries with each allowed mode selected by trusted policy | Same operation truth under PASS_THROUGH, DETERMINISTIC_RENDER and ONE_SHOT_RESPONSE_MODEL. | No extra inference for first two modes; at most one bounded response-model call for third; unavailable response capability takes safe response-only fallback. Restricted Main is separately counted. | Delivery-only recovery; no domain re-execution. |

Canonical F1–F4 are mandatory. F1's read-only precursor alone does not prove a mutation fast path. F4 cannot pass from a synthetic completed result or an uncorrelated docked state; synthetic tests prove only gate mechanics.

### Negative acceptance matrix

Inject unsafe races/provider faults in isolated tests against the installed native implementation first. Production fault injection requires specific approval; ordinary production canaries do not authorize forced restarts or outages.

| Case | Deterministic expected result / forbidden effect | Evidence owner |
| --- | --- | --- |
| Unavailable/invalid classifier, missing credentials, unsupported input, privacy restriction | Main before commitment; bounded diagnostic; no fabricated classified result. Native cancellation does not start fallback work. | S03/S04 |
| False fast-path attempts: context, pronouns, mixed domains, quoted instructions, pending clarification, unauthorized sender | Ineligible routes remain Main; trusted policy/permissions cannot be overridden by model confidence. Authorization rechecked at domain mutation. | S04/S05/S16 |
| Same admission twice; two distinct identical-text turns | One owner/finalization for duplicate admission; two independently owned workflows for real separate turns. | S03/S05 |
| Late classifier, cancellation, session replacement | Cannot steal commitment, dispatch a late domain or deliver into replacement conversation. | S03/S05 |
| Lost spawn acknowledgment; crash around commit/acceptance; uncertain side effects | Retain native owner/reconcile durable effects; zero competing Main dispatch, duplicate domain operation or blind retry. | S05 |
| Duplicate/stale/foreign/truncated/contradictory completion; forged provenance/destination | Reject or bounded native result recovery; no unauthorized continuation, success or duplicate final response. | S06/S07 |
| Partial failure, collection truncation, warnings, notification-intent failure | Every material result/effect survives; no all-success claim or silently incomplete list. Notification failure cannot rerun domain work. | S06/S08/S09/S12 |
| Generated failure-to-success, dropped warning, changed time, started-to-finished, invented fact | Reject candidate/model output; approved factual fallback; zero execution replay. | S09/S10 |
| Response model timeout, malformed output, unsupported shape, provider failure | Bounded response-only fallback; completed domain truth retained; no recursive model chain. | S09/S10 |
| Restricted Main tries tool/spawn/message/replay or repeats continuation | Effective policy denies; persistent budget prevents loop; return through controller or safe response fallback. | S11 |
| Conditional accepted/started/failed/unverified/stale/different-task completion | Predicate false/unknown; zero downstream Reminder mutations even if Main asks directly. Duplicate valid completion releases at most once. | S13 |
| Transcript/delivery failure after verified execution | Native delivery-only recovery retains ownership; no domain rollback/replay, no direct agent send, no second finalization. | S09/S17 |
| Cross-user pending context, stale revision/expiry, newer unrelated turn | Reject stale/foreign provenance without mutation; preserve correct native caller binding. | S06/S07/S15 |

Cleanup assertions are identity-based and bounded. Preserve current Reminder atomic transactions, Calendar linkage, fresh read results, full-list truth, native scheduled delivery and owner-diagnostic redaction. Do not restore old scheduler state over current operations. Uncertain physical/Calendar effects require deterministic reconciliation before any further action.

## 8. Architecture coverage and stage acceptance ledger

| Architecture boundary | Implementing stages / acceptance |
| --- | --- |
| Sections 3–4: logical controllers, provider-independent evidence, Main cognitive ownership | S01–S05; F1/F2 and classifier negatives |
| Section 5: exact current request, quoted minimal context, trusted runtime separation | S02/S03/S12/S15; F2 and provenance tests |
| Sections 6.3–6.5: TaskResultEnvelope, trusted routes, completion validation | S02/S06/S07; completion/duplicate matrix |
| Sections 6.6–6.7: caller continuation and truthful ResponseEnvelope | S07/S08/S12; F3 and partial failure |
| Sections 6.8–6.10/14: single response boundary, three modes, bounded response-only Main | S09–S11/S15; F5/F6 and response/no-replay negatives |
| Sections 6.11/17: scheduled delivery and Reminder continuity remain separate | S06/S07/S09/S15; notification/clarification negatives |
| Sections 7–8/13: native isolated lifecycle, zero skills, least privilege, privacy | S01/S03–S07/S11/S15–S17; identity/policy proofs |
| Sections 9–10: deterministic mutation/verification, exclusive commitment and recovery | S05–S07/S13/S17; restart/uncertainty/no-replay |
| Sections 11–12/15–16: minimum inference, latency/cost and owner observability | S04/S09–S11/S14/S16; measured native traces |
| Sections 18/24.4: physical completion and deterministic dependent mutation | S13/S17/S18; F4 including real positive completion |
| Sections 19–21/25–26: reuse, checkpoints, validation, snapshots and full acceptance | All changing stages; S15/S17/S18 |

Stage ledger: root engineering-contract prerequisite ACCEPTED (2026-09-25); S01 ACCEPTED (2026-09-25, decision only); S02 ACCEPTED (2026-09-25, private contracts only); S03 ACCEPTED (2026-09-25, staged admission only); OpenClaw 2026.9.6 upgrade prerequisite ACCEPTED (2026-09-26); S04 ACCEPTED (2026-09-27, provider-independent, Decision unavailable/not configured); S05–S18 NOT STARTED. Accepted historical preparation in Section 2 is retained evidence, not completion of these new stages.

- **Root engineering-contract prerequisite — ACCEPTED:** changed only `/home/oa/projects/benson/AGENTS.md`; rollback checkpoint `output/checkpoints/root-agents-pre-s01-20260925-171542/AGENTS.md`, verified pre-change SHA-256 `432e125c30a8e5cb99daab23a9e9b27f7c4293f80cf9453e9768dde5e05d47d9`; accepted root SHA-256 `ff1a59f5551623fa99603517273eaaf85b321815cb1aa34fb8e028e029b39217`. Diff was limited to replacing the stale `sole user-facing agent` wording with the approved Main/control/Response Controller boundary. `main/AGENTS.md` remained `5a3aabb8a3ee9e4f0e3258e3b876d6ff66682a68da066145589fc861910fc445`; `~/.openclaw/openclaw.json` remained `e4b5014fe9cda7de68889e0fbd439129a20a2d491e1f043cb43580c127604472`. No runtime/config/tool/loading behavior changed; no canary or snapshot required. Remaining gate: S01 native capability and ownership decision.

- **S01 — ACCEPTED (decision only, 2026-09-25):** changed only this canonical plan. Verified rollback checkpoint: output/checkpoints/benson-control-plane-s01-20260925-vfb3nC/BENSON_DECISION_ROUTING_IMPLEMENTATION_PLAN.md, pre-change SHA-256 2bb98912cb65f7331112a494b504674ea71a3ca32feed57f180502aaae48b89f. The plan diff contains one status edit, the S01 decision record and this ledger update. Installed/running OpenClaw 2026.9.4 matched by package, CLI and live Gateway RPC; four focused installed-source patch regressions passed. Root AGENTS.md, Main runtime AGENTS.md and active OpenClaw config retain their accepted hashes from the preceding row. No runtime exposure, canary, provider call, reload or domain action occurred; no snapshot is required for a plan-only decision. Rollback restores only this plan from the checkpoint after checking compatible subsequent edits. Remaining gate: Oren approval of the exact native host extension or an equivalent supported binding, and any later upgrade/registration/config or provider decision. S02 pure contracts may proceed while native runtime stages remain blocked.

- **S02 — ACCEPTED (private contracts only, 2026-09-25):** changed \`integrations/openclaw/benson-routing/envelope.mjs\`, new \`tests/contracts.test.mjs\`, and this ledger. Source rollback C is verified pre-change Git \`main\` commit \`8c90154994795c4f26f09048d48c1a6ca674f0b5\`; no runtime checkpoint R was needed. Common version 1 distinguishes trusted ExecutionRoute/CompletionRoute metadata, task result facts, and ResponseEnvelope; Jessica domain version \`1\` and Reminder \`legacy-unversioned\` preserve all 13 reviewed valid legacy fixture facts. Native task IDs and pending-context requester/conversation binding plus expiry are supplied separately; unknown versions, extra authority fields, duplicate task links, mismatched aggregate status, unverified success, and expired/foreign pending context fail validation. Main-only has explicit \`executionVerified: not_applicable\`; mixed outcomes require \`partial\`. Limits: 16 results, 64 warnings per result, 4096 rendered characters, 256 KiB JSON, 16 levels, 256 entries per collection. \`node --test .../tests/contracts.test.mjs .../tests/routing.test.mjs\`: 30/30 passed; after the final duplicate-task guard, focused contracts: 8/8 passed; \`node --check\` and \`git diff --check\` passed. Captured OpenClaw remains 2026.9.4; no native binding, config, agent instruction, provider call, reload, canary, delivery, or production exposure was changed or claimed. \`main/AGENTS.md\` and active config retained the S01 hashes. Snapshot \`output/context/benson-context-20260925-214207.md\` generated and verified (SHA-256 \`e6fa1d915285dca26031a827c5a4f36512e11eb8bde4088bed6a9e7f1a5c3f43\`). Remaining gate: S03 native admission binding requires the S01 host-boundary approval or an equivalent supported native surface; pure S02 contracts alone grant no execution or delivery authority.


- **S03 — ACCEPTED (staged admission only, 2026-09-25):** Oren approved only the focused version-bound OpenClaw reply-admission patch, with routing disabled in production. Changed integrations/openclaw/benson-routing/request-control.mjs, new tests/request-control.test.mjs, integrations/openclaw/patches/openclaw-2026.9.4-benson-request-admission.patch, and this ledger. Source rollback C is pre-change Git main commit b9b72bb9c92b660b51f85cc494800223a8695bd8; unrelated Jessica working-tree edits were excluded. No runtime checkpoint R was needed: the patch was applied only to a temporary copy of installed OpenClaw 2026.9.4 dist/dispatch-from-config-CmAXENud.mjs, never to the installed package. Native source-turn identity, existing dedupe/recovery and reply-operation ownership feed an exact bounded request projection after command/plugin/hook handling and before Main; duplicate/recovered/internal/cancelled/command/plugin-bound turns bypass classification, and unsupported or identity-unknown input stays on native Main handling. No Decision call, direct dispatch, completion or response control was registered. The native patch has three hunks confined to that reply-admission bundle: data-only projection, recovery disposition, and attachment to internal prepared state. The installed bundle remains SHA-256 83fa38143291448ea814c76a62971adb44f6f0b7e1aa09efd7ec53bb383910e7; active config and main/AGENTS.md retain S01 hashes. Isolated native-patch tests exercised the actual patched bundle and source-turn helper; node --test tests/request-control.test.mjs tests/contracts.test.mjs tests/routing.test.mjs: 37/37 passed. Patched bundle and new modules passed node --check; patch dry-run and focused diff checks passed. Current configured interactive channel is WhatsApp; other/unsupported ingress is explicitly bypassed or Main-only. No provider call, production canary, reload, device action or delivery occurred; temporary test copy was removed. Snapshot output/context/benson-context-20260925-215551.md verified, SHA-256 132df1856539bde689667fa2030dd7c72ca26e667ba60cb70937ff63cb8e177e. Remaining gates: S04 provider/model and household-data approval before external inference; S05 durable commitment or any other host boundary requires its own concrete approval. The S03 patch does not establish exclusive execution or activate routing.

- **OpenClaw 2026.9.6 upgrade prerequisite — ACCEPTED (2026-09-26):** Oren approved the stable 2026.9.6 target. Source rollback C is pre-change Git `main` commit `39aa3b49fecde2900e7514ad7b9a07682223d4eb`; protected runtime rollback R is `output/checkpoints/openclaw-2026.9.6-upgrade-20260925-223341/`, with verified package/state/service archives and SHA256SUMS digest `d0ebc96664aef033b568768cdb6a632b416f0eca69f426d663ed2e432a7525ca`. The active package and CLI are 2026.9.6; the previous installed package remains in that checkpoint. Four preexisting Benson safeguards were rebased into the same native owners by `integrations/openclaw/patches/openclaw-2026.9.6-benson-runtime-compat.patch`; the three-hunk S03 admission patch was ported in `openclaw-2026.9.6-benson-request-admission.patch` and tested in isolation, but is absent from the active package. Focused active regressions passed: seven Main failure cases; memory result admission, question lifecycle and sessions_yield; 42 routing/contract/request-control cases; Jessica 86/86; Reminder static/native reuse and simulated Calendar lifecycle. The Reminder native validator test path was updated for the new bundle. OpenClaw 2026.9.6 source captures moved module-relative non-code reads to temporary copies; existing Jessica/Reminder plugin owners now import their canonical JSON assets as static modules, and Reminder resolves its executable through native `api.resolvePath` from the original plugin root. Both plugins loaded through native runtime inspection (3 Jessica and 8 Reminder tools), and the live Gateway reached `gateway ready` with both included among seven loaded plugins. Active config SHA-256 stayed `e4b5014fe9cda7de68889e0fbd439129a20a2d491e1f043cb43580c127604472`; S03 and all new routing remain disabled. Local HTTP readiness passed; a full `gateway status` CLI probe timed out during Codex catalog hydration, and WhatsApp had a reconnect warning, so no physical conversation or domain action is claimed. No Decision provider or household inference was used. Verified snapshot `output/context/benson-context-20260926-073503.md` (SHA-256 `e4443db0833820e6e0f7265f69c9f9a85535e47d550bcc8892a09829fd4960cb`) records active OpenClaw 2026.9.6. Continue S04 against installed native `api.runtime.decisions.evaluate`; provider/model and household-data approval remains required before real inference.

- **Post-upgrade physical canary remediation — RUNTIME VALIDATED; PHYSICAL ACCEPTANCE PENDING (2026-09-26):** Oren sent two read-only WhatsApp requests ten seconds apart. The first Main turn was interrupted by the second inbound turn and returned a generic error at 07:57 IDT. The second requester-settle turn delivered a visible WhatsApp answer at 07:59 with nine active reminders, while explicitly reporting Jessica as unverified; Gateway outbound and the Main transcript corroborate Oren's screenshot. Native Jessica `status` and Reminder `list` succeeded, and no new Jessica physical operation state was persisted. OpenClaw 2026.9.6 records plugin calls made through `exec` as `openclaw.nested-tool.v1` custom transcript messages; the existing Jessica completion validator accepted only direct `toolResult` entries, so it failed closed with `No deterministic Jessica tool result`. The existing Jessica plugin validator now requires the native nested event, exact child run and outer call correlation, matching inner result, outer execution value and child final JSON; direct native tool results remain supported. Focused completion tests passed 7/7, including malformed provenance, and read-only replay of the exact production Jessica transcript passed at its original completion time. Source rollback C is pre-change Git `dbfb75fa74207689ece4d689e3916a494ea1a3d1`; verified runtime checkpoint R is `output/checkpoints/openclaw-2026.9.6-jessica-completion-20260926T050929Z/` (seven SHA256SUMS entries and SQLite quick checks). Unchanged config validated with SHA-256 `e4b5014fe9cda7de68889e0fbd439129a20a2d491e1f043cb43580c127604472`. One Gateway reload loaded seven plugins including Jessica and Reminder; HTTP 200 and WhatsApp listening were observed. The earlier timed-out canary is not accepted: one isolated WhatsApp status request and visible delivery, followed by deterministic transcript/operation checks, remain required. S03 admission and all new routing remain disabled; S04 Decision provider approval remains pending. The repair and ledger were committed as `76e4397`; a fresh runtime snapshot `output/context/benson-context-20260926-081853.md` was generated and verified (SHA-256 `700db32d12cc883c9d0636014964fb1a5c851b4139b386f1d688aeadb15a2e14`, active OpenClaw 2026.9.6).

- **S04 — NATIVE DECISION ADAPTER VALIDATED; REAL PROVIDER BINDING PENDING APPROVAL (2026-09-26):** source rollback C is pre-change Git `main` commit `5507a170ec00eea4f36ecd26068f413dc9d3e481`; changed only `integrations/openclaw/benson-routing/classification.mjs`, focused `tests/routing.test.mjs`, and this ledger. The previous 2026.9.4 `llm.complete` preparation (commit `e259daecf6d797d05a4013453a7bd984c8b1e1c7`) was superseded by the installed 2026.9.6 `PluginRuntime.decisions.evaluate(DecisionBatch, { agentId, purpose, rubricVersion, timeoutMs, signal })` contract in `dist/types-CB02460N.d.ts`. The adapter sends only the exact current message and reviewed semantic rubric as native state, plus five bounded choice questions. Context flags use `yes`/`no`/`unknown`; no missing flag is forced false. Native provider/model/rubric/generation provenance is required; unsupported, malformed, unavailable, cancelled, timed-out and late outcomes select Main. Native choice distributions and provider confidence are not promoted to calibrated routing probabilities, so `routeConfidence` and `selfContainedProbability` remain unknown and no fast path opens. Synthetic native-contract tests passed `node --test` routing/contracts/request-control: 42/42; `node --check`, focused diff checks, active package 2026.9.6, unchanged config SHA-256 `e4b5014fe9cda7de68889e0fbd439129a20a2d491e1f043cb43580c127604472`, and absent production S03 admission patch were verified. No Decision provider, external inference, plugin registration, host change, config change, production routing, device action or physical delivery occurred; no snapshot is required for this non-activated source preparation. S04 remains unaccepted for real binding until Oren approves provider/model and exact household-message/rubric handling, after which actual native result and score semantics must be proved. S05 does not start.

- **S04 — ACCEPTED (provider-independent, Decision unavailable/not configured, 2026-09-27):** Oren explicitly selected the unavailable-provider acceptance path; Jev is not currently available to him. The existing `classification.mjs` native Decision adapter and `policy.mjs` required no contract change. Source rollback C for this ledger-only update is verified pre-change Git `main` commit `acfb3e2e9fddde9f81cf3f29d089f3fc924ca789`; unrelated working-tree edits were excluded. Installed OpenClaw is 2026.9.6 (`eb377ac`), with `DecisionRuntimeV1` exposed through the plugin API. Current non-secret config has no global or Main `decisionModel`, and the plugin inventory has no `onnx` or `typesafe` provider; active config SHA-256 remains `e4b5014fe9cda7de68889e0fbd439129a20a2d491e1f043cb43580c127604472`. Focused `node --test integrations/openclaw/benson-routing/tests/routing.test.mjs` passed 27/27. A direct no-provider probe, without a test double, observed `unavailable/not_configured` and deterministic `main/classifier_unavailable`. Test doubles occur only in tests; no Decision result was fabricated in production. The S03 admission patch is absent from the installed dispatch bundle; no provider call, external inference, plugin installation, configuration change, runtime routing, reload, device action or delivery occurred. Production routing remains disabled. No runtime checkpoint R or new snapshot is required for this plan-only acceptance; the latest snapshot remains `output/context/benson-context-20260927-065656.md`. Real provider binding is deferred to a separately approved provider/model and household-data decision, using the unchanged S04 contract. Next stage is S05; its native durable commitment/recovery dependency and host-boundary approval remain gates, and it may not enable production routing.

For each stage append one concise acceptance row here: stage; changed canonical paths; checkpoint/hash; exact tests/results; installed native binding/version; production exposure; canary/native evidence; cleanup/final state; snapshot if required; remaining gate. Do not paste transcripts or create a second active implementation plan.

## 9. Plan-only checkpoint, validation and rollback

Previous canonical plan checkpoint:
`output/checkpoints/benson-control-plane-plan-20260925-VF32TA/BENSON_DECISION_ROUTING_IMPLEMENTATION_PLAN.md`.

Verified pre-replacement SHA-256:
`c19664dd2f7babe8dae280cc5c0718f2bd209565617ec63ee5c3c609baf24313`.
The checkpoint matched the canonical old plan byte-for-byte before replacement and was rechecked after interruption. `protected-owners.sha256` in the same directory records the pre-edit architecture/instruction/routing/domain-plugin/config/package fingerprints.

Plan validation required before handoff: all 18 stages contain objective/invariant, owner, inspection, exact scope, exposure, checkpoint, deterministic validation/expected result, acceptance, rollback, stop/native dependency and approval; Section 8 covers important architecture boundaries; all local source links resolve; assets and native gaps are explicit; no unsupported capability is treated as proven. Recheck protected-owner hashes and checkpoint hash. Do not run runtime tests, provider calls, canaries or `bensonsnap` for this plan-only replacement.

Document rollback, from `/home/oa/projects/benson`, after verifying the recorded checkpoint hash:

```sh
sha256sum output/checkpoints/benson-control-plane-plan-20260925-VF32TA/BENSON_DECISION_ROUTING_IMPLEMENTATION_PLAN.md
cp -p output/checkpoints/benson-control-plane-plan-20260925-VF32TA/BENSON_DECISION_ROUTING_IMPLEMENTATION_PLAN.md BENSON_DECISION_ROUTING_IMPLEMENTATION_PLAN.md
cmp -s output/checkpoints/benson-control-plane-plan-20260925-VF32TA/BENSON_DECISION_ROUTING_IMPLEMENTATION_PLAN.md BENSON_DECISION_ROUTING_IMPLEMENTATION_PLAN.md
```

Restore only the plan; leave accepted preparation, architecture, runtime configuration and durable operation history unchanged. Historical checkpoint/snapshot/record retention follows Section 2's bounded dependency rule; no cleanup is part of this rollback. No service reload or runtime rollback is needed. This procedure is documented, not executed.

Final planning validation result is recorded in the checkpoint's `plan-validation.md`. That file is evidence only, not a second active plan. Stop after the replacement and validation; do not implement S01.
