# Isolated Tool Execution Receipt / Run Settlement Seal

Temporary OpenClaw **Core/SDK** exception approved 2026-11-02, Plan §11.48.
Only disposable isolated acceptance is authorized. No production installation,
Gateway changes, plugin registration, messages or device actions are authorized.
The separate WhatsApp Plugin patch remains byte-identical and separately owned.

`manifest.json` is the sole version/hash/file inventory; `2026.10.4.patch` is the
single canonical patch. No layered patch, fuzzy application, automatic rebase or
compatibility fallback is supported. Upstream: npm `openclaw@2026.10.4`, matching
the locked installed dependency. Exact pre/post SHA-256s and patch SHA-256 are in
the manifest, not duplicated here.

## Boundary and contract

Five existing native files change:

- `dist/run-entry-gnb95g__.mjs`: observe the actual logical Run identity; seal
  after the original requester settlement path; track each dispatched candidate.
- `dist/selection-lyiH3_Xg.mjs`: identify supported builtin harness dispatch by
  native provenance, never its name or a model assertion.
- `dist/agent-core-RzJjRVA2.mjs`: bounded in-memory observations at native batch
  admission, validated/prepared arguments, original execution outcome, final
  outcome, assistant messages and Agent lifecycle. It also holds the observer
  implementation, avoiding added dist files that native postinstall prunes.
- `dist/builtin-openclaw-qVsnLx0N.mjs`: nested execution makes coverage incomplete.
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
to have exactly one outcome, and exact message/batch identity/argument coverage.
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
all five original files. It cannot undo messages, device effects or domain state;
none are authorized by this exception. Source rollback uses the existing TS04
checkpoint and preserves the prior candidate, policies and WhatsApp patch.

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
