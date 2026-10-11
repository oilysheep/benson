# Benson Phase 2 Backlog

Deferred evaluation index, recorded 2026-10-11. The canonical Architecture and
Implementation Plan remain authoritative; this file owns no policy, proof gate,
execution sequence or acceptance contract. All items below are DEFERRED under
[Plan §1.5.1][phase1], not approved implementations. G11 remains OPEN.
Phase 1 scope, essential security controls and runtime are unchanged. A concrete
unsafe exposure still blocks its affected capability; it is not postponed here.

| Item | Rationale | Current limitation | Future evaluation criteria | Canonical reference |
| --- | --- | --- | --- | --- |
| Advanced G11 isolation | Establish enforceable domain ownership while preserving legitimate Main capabilities. | Main retains `full`; behavioral Domain-First routing and bounded canaries do not prove complete isolation. | Verify installed harness policies, inherited permissions and owner/Main/foreign-agent boundaries. Compare supported native options and capability tradeoffs; require observed evidence before G11 PASS. | [Architecture §8.1][ownership]; [Plan G11/A20][gates], [acceptance matrix][acceptance]. |
| Advanced agent guardrails | Reduce instruction-injection and privilege-confusion risks without redundant orchestration. | Existing authorization, currentness and validators are mandatory; advanced adversarial coverage is incomplete and no additional guardrails mechanism is selected. | Evaluate realistic untrusted-content cases at existing admission/tool boundaries, false rejections, recovery and latency/token cost. Prefer enforceable native controls; prompt compliance alone is insufficient. | [Architecture §§8.1/13][ownership], [source authority][authority]; [Plan §1.5.1][phase1]. |
| Indirect bypass prevention | Prevent general tools from circumventing domain authorization and verification. | Comprehensive denial through `exec`, Code Mode, raw HA and native job management remains unproven. | Use bounded, separately approved native proofs for relevant read/mutation paths and delegated contexts. Demonstrate denial without unauthorized effects; preserve Main's legitimate tools and domain safety guarantees. | [Architecture §8.1][ownership]; [Plan G11][gates] and [ED06][migration]. |
| Industry best-practice research | Inform the above decisions with current evidence rather than speculative hardening. | Existing research is dated and boundary-specific; it does not select or prove an advanced isolation/guardrails solution. | Compare current upstream/installed OpenClaw, official provider documentation, authoritative security standards and credible production evidence. Assess security benefit, compatibility, reliability, latency, tokens and maintenance; record any decision in its canonical owner. | [Architecture §27.2][research]; [AGENTS.md][workflow]. |

[phase1]: BENSON_DECISION_ROUTING_IMPLEMENTATION_PLAN.md#151-limited-phase-1-runtime-acceptance--operator-decision-2026-10-11
[gates]: BENSON_DECISION_ROUTING_IMPLEMENTATION_PLAN.md#5-explicit-implementation-proof-gates
[acceptance]: BENSON_DECISION_ROUTING_IMPLEMENTATION_PLAN.md#9-acceptance-matrix
[migration]: BENSON_DECISION_ROUTING_IMPLEMENTATION_PLAN.md#ed06--migration-and-cutover-readiness
[ownership]: architecture/BENSON_SUBAGENT_ARCHITECTURE.md#81-exclusive-domain-tool-ownership
[authority]: architecture/BENSON_SUBAGENT_ARCHITECTURE.md#13-least-privilege-and-source-authority
[research]: architecture/BENSON_SUBAGENT_ARCHITECTURE.md#272-native-decision-evidence
[workflow]: AGENTS.md
