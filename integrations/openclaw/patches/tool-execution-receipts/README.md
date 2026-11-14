# Isolated Tool Execution Receipt / Run Settlement Seal

Temporary OpenClaw **Core/SDK** exception, Plan §11.48; the operator approved
source/isolated qualification for 2026.10.10 on 2026-11-14 (§11.65).
Only disposable isolated acceptance is authorized. No production installation,
Gateway changes, production registration, messages or device actions are authorized.
The separate WhatsApp Plugin patch remains byte-identical and separately owned.

`manifest.json` is the sole active version/hash/file inventory;
`2026.10.10.patch` is the current canonical patch. The unchanged `2026.10.4.patch`
is retained historical evidence, not permission to apply it to another release. No layered patch, fuzzy application, automatic rebase or
compatibility fallback is supported. Target: npm `openclaw@2026.10.10`, source commit
`7dc3350cb9f08fcf9a0af5c4845a20d5b2f1a8be`; checkout dependencies may still be
2026.10.4 and do not qualify this target. K11 remains independently pinned. Exact pre/post SHA-256s and patch SHA-256 are in
the manifest, not duplicated here.

## Boundary and contract

Six existing native files change:

- `dist/run-entry-Cb2bxd3B.mjs`: observe the actual logical Run identity; seal
  after the original requester settlement path; track each dispatched candidate.
- `dist/runtime-embedded-agent.runtime-DXtEzTGU.mjs`: observe the separate public SDK
  child entry; seal after terminal-write draining and requester cleanup. This file
  requires the exact K11 preimage: apply K11 first and roll back receipts first.
- `dist/selection-BSj0bLZy.mjs`: identify supported builtin harness dispatch by
  native provenance, never its name or a model assertion.
- `dist/agent-core-BucXfq8L.mjs`: bounded in-memory observations at native batch
  admission, validated/prepared arguments, original execution outcome, final
  outcome, assistant messages and Agent lifecycle. Each attempt captures the
  actual `agent_end.messages` projection; no plugin `agent_end` hook is assumed
  for detached children. It also holds the observer
  implementation, avoiding added dist files that native postinstall prunes.
- `dist/builtin-openclaw-4RNo5CR8.mjs`: nested execution makes coverage incomplete.
- `dist/plugin-sdk/agent-core.js`: additive read-only observer and provider
  metadata exports. No public declarations, execution API or tool is added.

The observer is synchronous, host-private and selected by exact native
sessionKey. The native logical Run supplies runId/sessionId/sessionKey/agentId
and an opaque per-invocation token. Receipt ordinal is admission order, not
completion order; attempt distinguishes native Agent invocations. Native batch
input arguments, validated arguments and prepared implementation arguments are
separate snapshots. `originalResult`/`originalIsError` precede native after hooks;
`result`/`isError` follow native outcome hooks/warnings. Result snapshots contain
only public `content` and optional `details`; internal metadata is excluded.
Original arguments mean native message/batch input, not provider network bytes.

A complete seal requires every dispatched candidate to cross the supported
harness/Agent boundaries, no active attempt/candidate, all observed native calls
to have exactly one outcome, one bounded terminal projection per attempt, and
exact message/batch identity/argument coverage. The adapter's terminal consumer
admits exactly one attempt and only after the complete live logical seal;
the Agent terminal event alone never establishes settlement.
Duplicate identities, unsupported harnesses, nested calls, overflow, capture or
observer failure, aborted/failed lifecycle, missing outcome or unsettled work
cannot establish complete coverage. Completion also checks the retained native
`isCurrent()` capability at use time; a copied seal is insufficient. A complete
seal proves enumeration, not tool success, business authorization, physical
verification, transcript persistence or original user admission.

Maximum 64 calls per Run; snapshots are bounded by 32 levels, 32,768 nodes and
1 MiB string/key bytes. Unsupported values fail evidence closed without changing
native execution/result/error semantics. Native result carriers have a separate
1 MiB serialized budget in Benson; domain details retain existing domain bounds.
Evidence is ephemeral and privately retained by the existing adapter, never a
new durable store. Loss/restart or absent seal remains unverified, with canonical
Operation State/effects preserved and no replay. Direct SDK loops, CLI/custom
harnesses and nested execution are not accepted coverage profiles.

Benson `core/tool-execution-evidence.ts` owns the provider-neutral contract and
opaque live custody. Only `adapters/openclaw/tool-execution-evidence.ts` knows
this patch protocol and validates the canonical manifest against all installed
post-image hashes before subscribing. Completion, DomainResult and Operation
State import no patched native internals. Domain adapters independently validate
actual arguments and original domain results. Mutations require a private
per-call domain verifier retained by the existing tool factory: Jessica captures
read-only matching request history/active state within its executor; Reminder
retains its already verified canonical transaction. Parent/source custody remains
mandatory after child tool custody retires. Model reports remain proposals.
The explicit pure-read/native-seal profile validates the original receipt's
execution arguments and domain DTO without requiring optional plugin hooks;
its Completion outcome correlation fields are projections of native receipts,
not claims that a plugin hook fired. Default mutation/witness collectors retain
their existing hook requirements. This is an explicit profile, never a fallback.
`after_tool_call` payloads are sanitized/truncated observational projections;
Completion correlates their identity/errors but obtains original and final
outcomes only from native receipts. Domain verification matches the original
domain result, never a sanitized projection.

## Deterministic maintenance

Read-only host preflight (does not apply anything):

```sh
node integrations/openclaw/patches/tool-execution-receipts/manage.mjs preflight node_modules/openclaw
```

Inside the existing isolated namespace only, with the SDK temporary overlay at
`/repo/node_modules/openclaw`, host home hidden, and this owner mounted read-only
at `/receipt-patch`:

```sh
node /receipt-patch/manage.mjs preflight /repo/node_modules/openclaw
node /receipt-patch/manage.mjs apply /repo/node_modules/openclaw
node /receipt-patch/manage.mjs verify /repo/node_modules/openclaw
node /receipt-patch/manage.mjs rollback /repo/node_modules/openclaw
node /receipt-patch/manage.mjs preflight /repo/node_modules/openclaw
```

Every action checks package version, patch digest and **all** required pre/post
images before acting. Apply/reverse first dry-run with zero fuzz, then verify
all resulting hashes. Unknown version, source drift, already/partially applied
state or incompatible contract rejects. No mutation command accepts a host
installation. A filesystem/process failure during application is not atomic:
discard that disposable namespace; do not try to repair/reapply a partial tree.
Rollback is hash-guarded and requires the exact complete post-image. It restores
all six original files. It cannot undo messages, device effects or domain state;
none are authorized by this exception. Source rollback uses
`.checkpoints/domain-run-g1b-g2-20261109/g2-native-evidence-20261114-TD2DTp/`
verified beforeimages (including the separately saved Completion/test owners),
restoring only this slice's changes and preserving preexisting dirty state,
K11, policies, runtime history and the WhatsApp patch. The historical TS04
checkpoint remains required evidence; it is not a current-tree rewind target.

For any future upgrade: keep this candidate and its recoverable pin; inspect
current official hooks/transcript/Core APIs first. Compare original native
ownership and execution/settlement paths against every insertion point. If an
official extension supplies equivalent guarantees, replace the adapter provider
and remove this patch after equivalent acceptance. Otherwise seek approval for
a newly pinned minimal patch, regenerate one canonical diff against pristine
exact source, record all hashes, and rerun the full isolated matrix plus affected
Completion/domain checks and independent review. Never silently rebase, change
the target version or combine the WhatsApp patch with this patch. Production
activation/rollback needs a separately approved installation/lifecycle plan.

## Acceptance and research

Strict build and focused domain/Completion tests; isolated real logical Runs
with 3/5 parallel, reordered calls, concurrent Runs/reused call IDs, zero calls,
blocked/failed/synthetic calls, adjusted arguments, duplicate native identities,
interruption and unsealed evidence. Deterministic negatives cover missing
receipts, foreign identities, forged serialized evidence, version/source drift,
partial/repeated application and reverse verification. Real domain factory
witnesses must preserve canonical effects and uncertainty without replay.
Exact observed results and limits belong in Plan §11.48/checkpoint validation;
this list is an acceptance requirement, not a claim that it has passed.

Installed evidence is authoritative for this pin. Current primary references:
[upstream Agent types](https://github.com/openclaw/openclaw/blob/main/packages/agent-core/src/types.ts),
[official hook contracts](https://docs.openclaw.ai/plugins/hooks/reference),
[official session hooks](https://docs.openclaw.ai/plugins/hooks/prompt-and-session).
Hooks alone have no complete Run enumeration/settlement guarantee and may
transform/sanitize outcomes. Supported transcript reads add persisted projection,
not authoritative execution-start/original-result or a complete settlement seal.
The temporary native exposure is selected only for those missing guarantees;
rolling upstream APIs are not assumed installed support. Phase2 replacement is
an explicit obligation in PHASE2_BACKLOG.md, not a deferral of Phase1 evidence.
