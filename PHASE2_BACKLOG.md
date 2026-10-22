# Benson Phase 2 Backlog

Deferred evaluation index, recorded 2026-10-11. The canonical Architecture and
Implementation Plan remain authoritative; this file owns no policy, proof gate,
execution sequence or acceptance contract. All items below are DEFERRED, not
approved implementations. Phase 1 deferrals follow [Plan §1.5.1][phase1]. G11 remains OPEN.
Phase 1 scope, essential security controls and runtime are unchanged. A concrete
unsafe exposure still blocks its affected capability; it is not postponed here.

| Item | Rationale | Current limitation | Future evaluation criteria | Canonical reference |
| --- | --- | --- | --- | --- |
| Optional native Main Completion (deferral approved 2026-10-22) | Main uses native Run lifecycle in Phase 1; avoid requiring Completion v5 for cognitive orchestration. | Mandatory Main Response interception remains unproven on `2026.10.4`; this deferral waives no response authorization, factual preservation, tool isolation or Domain Completion guarantee. | Reevaluate supported native Main Completion interfaces and their benefit only after exact authority/terminal/recovery proof, without core changes or another lifecycle owner. Domain G1(b)/G2/G11 and common Response/G3 remain Phase 1 obligations for their enabled scope. | [Architecture §4.3][main], [Domain Completion/Response][completion]; [Plan refinement][refinement]. |
| Advanced G11 isolation | Establish enforceable domain ownership while preserving legitimate Main capabilities. | Main retains `full`; behavioral Domain-First routing and bounded canaries do not prove complete isolation. | Verify installed harness policies, inherited permissions and owner/Main/foreign-agent boundaries. Compare supported native options and capability tradeoffs; require observed evidence before G11 PASS. | [Architecture §8.1][ownership]; [Plan G11/A20][gates], [acceptance matrix][acceptance]. |
| Advanced agent guardrails | Reduce instruction-injection and privilege-confusion risks without redundant orchestration. | Existing authorization, currentness and validators are mandatory; advanced adversarial coverage is incomplete and no additional guardrails mechanism is selected. | Evaluate realistic untrusted-content cases at existing admission/tool boundaries, false rejections, recovery and latency/token cost. Prefer enforceable native controls; prompt compliance alone is insufficient. | [Architecture §§8.1/13][ownership], [source authority][authority]; [Plan §1.5.1][phase1]. |
| Indirect bypass prevention | Prevent general tools from circumventing domain authorization and verification. | Comprehensive denial through `exec`, Code Mode, raw HA and native job management remains unproven. | Use bounded, separately approved native proofs for relevant read/mutation paths and delegated contexts. Demonstrate denial without unauthorized effects; preserve Main's legitimate tools and domain safety guarantees. | [Architecture §8.1][ownership]; [Plan G11][gates] and [ED06][migration]. |
| Industry best-practice research | Inform the above decisions with current evidence rather than speculative hardening. | Existing research is dated and boundary-specific; it does not select or prove an advanced isolation/guardrails solution. | Compare current upstream/installed OpenClaw, official provider documentation, authoritative security standards and credible production evidence. Assess security benefit, compatibility, reliability, latency, tokens and maintenance; record any decision in its canonical owner. | [Architecture §27.2][research]; [AGENTS.md][workflow]. |
| Reminder Python-to-TypeScript migration (deferral approved 2026-10-17) | Complete language consolidation after the current one-shot migration without expanding its scope. | The existing Python transaction and discovery engines remain authoritative and preserved throughout TS01–TS05; this entry authorizes no implementation. | Revisit only after TS05 acceptance, with a separately approved plan to migrate the existing owners to strict TypeScript. Preserve all existing functionality, atomicity, idempotency, Calendar/Automation integration, authorization, recovery and tests; prove behavior/effect-trace compatibility and pass the retained tests before replacement. | [Plan §11.1][ts-scope], [TS01–TS05 gates][ts-stages]; [Reminder contract][reminder-contract] and [existing owners][reminder-owners]. |

[phase1]: BENSON_DECISION_ROUTING_IMPLEMENTATION_PLAN.md#151-limited-phase-1-runtime-acceptance--operator-decision-2026-10-11
[gates]: BENSON_DECISION_ROUTING_IMPLEMENTATION_PLAN.md#5-explicit-implementation-proof-gates
[acceptance]: BENSON_DECISION_ROUTING_IMPLEMENTATION_PLAN.md#9-acceptance-matrix
[migration]: BENSON_DECISION_ROUTING_IMPLEMENTATION_PLAN.md#ed06--migration-and-cutover-readiness
[ownership]: architecture/BENSON_SUBAGENT_ARCHITECTURE.md#81-exclusive-domain-tool-ownership
[authority]: architecture/BENSON_SUBAGENT_ARCHITECTURE.md#13-least-privilege-and-source-authority
[research]: architecture/BENSON_SUBAGENT_ARCHITECTURE.md#272-native-decision-evidence
[workflow]: AGENTS.md
[ts-scope]: BENSON_DECISION_ROUTING_IMPLEMENTATION_PLAN.md#111-objective-scope-and-evidence-baseline
[ts-stages]: BENSON_DECISION_ROUTING_IMPLEMENTATION_PLAN.md#116-ordered-execution-slices-and-gates
[reminder-contract]: agents/reminder-service/AGENTS.md
[reminder-owners]: agents/reminder-service/README.md
[main]: architecture/BENSON_SUBAGENT_ARCHITECTURE.md#43-main
[completion]: architecture/BENSON_SUBAGENT_ARCHITECTURE.md#6-common-completion-and-response-contracts
[refinement]: BENSON_DECISION_ROUTING_IMPLEMENTATION_PLAN.md#1114-maindomain-refinement-within-ts03--2026-10-22
