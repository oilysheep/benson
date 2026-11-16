# WhatsApp Response Controller exception

This is an upstream WhatsApp Plugin patch, not an OpenClaw core/SDK patch or an
unchanged supported extension. The pinned2026.10.10 adaptation is approved for
the bounded TS05 deployment. Jessica status and Reminder list passed real WhatsApp E2E on2026-11-09; the Gateway is stopped and any new activation needs approval (Plan §11.64).

## Complete patch inventory

| Surface | Exact inventory / responsibility |
| --- | --- |
| Official package / host | `@openclaw/whatsapp@2026.10.10` / `openclaw@2026.10.10`; archive integrity and both artifact hashes are authoritative in `manifest.json`. The exact host combination is qualified for TS05's two no-Run reads; it does not extend the separate Core/SDK receipt patch. |
| Modified upstream artifact | Only `dist/.setup/monitor-B5qdng3U.mjs`; two hunks: add `createBensonResponseDispatch` and wrap the existing monitor's `dispatchReplyFromConfig` assembly. |
| Controller binding | Existing account-scoped `benson.response-controller.v1` runtime context; synchronous `createTurn`, resolver closure plus frozen final native context/signal handoff, synchronous final gate. |
| Enforcement | Early deny gate plus final gate after native hook assembly; current binding/signal, one resolver, one approved terminal text, no streaming/progress/alternate payload; rejection, unauthorized fallback and duplicate attempts blocked. |
| Unmodified by this plugin diff | Channel registration/account identity, listener/reconnect, lifecycle/queue, formatting/transport/receipts. The separate approved two-owner Core workspace correction is inventoried in Plan §11.64; this row does not claim stock Core or authorize deployment. |
| Benson consumer | Existing Response Controller owner and existing domain/admission/Completion owners. NativeDispatchReadAdmission v3 is Benson code; it adds no further plugin diff or native authority. |
| Proof-only instrumentation | Ephemeral symbol visibility and synthetic socket loader in the isolated fixture, outside this patch; never deploy that instrumentation or fixture policy/backend/binding. |
| Recovery / upgrade | Pin exact archive and before/after hashes, zero-fuzz apply, retain prior recovery; unknown bytes/version reject. Requalify the complete matrix after any approved upgrade; no auto-reapply. |

Existing historical OpenClaw core patches in the parent directory are separate
inventoried drift, not dependencies or authorization for this plugin candidate.
The Phase 2 replacement item owns migration to an official extension/upstream
integration; this inventory introduces no deployment or universal-enforcement claim.

### Connection diagnostics dependency — temporary, NOT currently installed

Patch ID: `connection-diagnostics-2026.10.10`. The separate temporary upstream
**WhatsApp Plugin patch** is `2026.10.10-connection-diagnostics.patch`;
`connection-diagnostics.manifest.json` owns exact dependency, preimage/postimage,
mode, installed-host/dependency pins and limits. Existing accepted Response patch
and manifest remain unchanged. This is not a Core/SDK or Baileys patch.

Target host/plugin:2026.10.10; Baileys7.0.0-rc14; ws8.22.0. Stack only on the
accepted Response patch. Four native targets, relative to the official plugin:

| Target | Contract |
| --- | --- |
| `dist/.setup/monitor-B5qdng3U.mjs` | Reuse native runId/connectionId; separate setup, retry scheduling/wait/abort and cumulative summary. Preserve Response insertion and native retry decisions. |
| `dist/.setup/connection-controller-g_8-U3na.mjs` | Setup stage/original rejection before cleanup; existing AbortSignal passed to factory; owner close intent and diagnostic-listener cleanup. Original errors/rethrows remain native. |
| `dist/.setup/socket-close-BvdLXlbQ.mjs` | Bounded closed projection, actual constructor entry/return counts, passive transport/stream observations and two sanitized existing error-log arguments. Temporary one-reservation cap before auth; cancellation recheck immediately before construction. Observe existing backup/current save stages through the native save callback. |
| `dist/.setup/auth-store-DMOniiuA.mjs` | Observe existing queue tails and active save stages; emit bounded barrier entry/outcome snapshots. Preserve queue/error ordering, captured-tail waiting, the15000ms default timeout and atomic publication/durability. |

No new public SDK capability, production tool, registry, persistence or logging
service. Internal correlation adds no authority or Completion evidence. Records
are limited to2KiB/event and64/module, a stricter total bound than per-attempt;
truncation/overflow/logger failure cannot establish complete capture. Missing
close metadata after Baileys end() is UNAVAILABLE, never a remote-close claim.
Privacy qualification covers only new records and the two touched error sinks.

Source provenance: repository base commit and exact artifact/source pins are in
the manifest. Its source-qualification record predates publication and retains
sourceCommit=null; the publishing Git commit identifies the unchanged artifact.
The verified recoverable baseline, emitted logs, focused validation and required
independent review belong to Plan §11.65 under
`connection-diagnostics-source-QwMrqY`. The approved save-stage extension and
consumer qualification belong to `save-stage-extension-cM1hxH`; source/isolated
approval does not permit installation or activation. The later separately
approved bounded live session is recorded below; its temporary files were restored.

The save-stage extension uses diagnostic-only metadata in a WeakMap keyed by
existing native tail Promises. It records opaque process-local save/predecessor
IDs, pending count, active stage/age and barrier outcome; no auth paths, values,
errors or message content. It adds no queue, persistence or authority owner.
Snapshots occur only at barrier entry/outcome within the unchanged2KiB/64-record
budget. Missing metadata or logging failure cannot prove a complete capture.
The tail ID identifies the Promise captured before logging; active save/backlog
are live snapshots and can include later work after that captured tail drains.
Stage attribution cannot distinguish atomic helper internals such as fsync,
rename or a path-queue predecessor. It is evidence for diagnosis, not a stall fix.

SchemaVersion1 has a closed optional extension for queue-barrier events. Pair
this producer with the exact qualified session consumer; older consumers reject
these fields/events. The consumer retains correlated setup entries across native
monitor runs while separately reporting retry-policy FAIL. Retry scheduling,
executed retry waits and setup entries never imply another socket constructor
or authorize a retry. Unknown fields, identities, sequence gaps, additional
constructors and missing monitor summaries still fail closed. The private
qualified consumer is not bound to a live session by source qualification.

Focused qualification: strict build PASS; three new inert/native save cases PASS
(ordering/error/captured-tail/publication, backup timeout without cancellation,
logger failure without changing saves), including1000 distinct barrier IDs with
bounded deduplication/logging and closed overflow projection; four-file zero-fuzz apply and exact
rollback/modes PASS. Offline replay retains all53 existing native records,
reports four setups/three monitor runs/one constructor and retry-policy FAIL;
17 focused consumer checks PASS. The earlier17-case diagnostic/topology evidence
is retained at its original artifact hash, not claimed as rerun on this candidate.
The actual production pending save/stage/cause remains UNKNOWN.

Topology is bounded to the root native channel manager and its captured runtime
record, one account, no module reload/generation replacement, login, standalone
inbox/live-directory calls or external admin path. Separate prepared agent
registries need not share a factory, and their existence is not a constructor.
The initial two-owner counterexample remains retained; no universal singleton
is claimed. The real root loader and prepared-registry proof qualifies only the
closed admitted process callgraph. The module cap alone never proves a
process-spanning budget: Restart=always allows another process with fresh
counters, and polling detects rather than prevents that entry. Live use requires
the separately approved, qualified temporary Restart=no policy in the existing
service owner and its preactivation guard; no global registry/new supervisor.

Bounded live evidence: Plan §11.65, `combined-runtime-repeat-20261116-F7y3Ff`,
records one activation below15minutes, one socket, zero retries and one exact
authorized read-only request. Main → fresh Jessica child/read → checked
Completion v6 NORMAL → Main → authorized native delivery and visible status
reply passed independent review. This is checked-success-path evidence; raw live
receipts/seal/private Completion authority were not separately retained. All nine
temporary session files and original service policy were restored; the Gateway
is inactive/disabled. Historical save-stall/408/428 causes remain UNKNOWN. Whole
G2 lifecycle and G1(b) reliability remain OPEN; publication grants no activation.

Recovery: before separately approved installation, verify all four installed
preimages/modes/owners, protect exact copies outside active directories and
confirm service disabled/inactive. Restore only these four preimages while
stopped, preserving the accepted Response patch and all native auth/history.
Any separately approved temporary service setting must be restored and verified
independently. Unknown bytes/version/provenance or incomplete recovery blocks
exposure. File restoration does not undo external effects.

Upgrade: inspect the exact official replacement for equivalent supported
lifecycle diagnostics/admission. Retire this dependency if equivalent proof is
available; otherwise request a version-pinned adaptation. Never auto-reapply or
promote the temporary cap into a permanent operational default. Qualification
and live exposure remain the canonical Plan's responsibility.

`manifest.json` pins the official npm archive integrity, plugin/host versions,
and original/patched SHA-256 of the single monitor artifact. The isolated proof
extracts the verified archive into its own disposable directory, applies the
adjacent diff with zero fuzz, checks the resulting hash, and mounts it read-only
inside network/filesystem namespaces. It never modifies host-installed packages.
Unknown versions, content hashes, or patch applicability must block execution;
never automatically reapply this patch after an upgrade.

For a fresh source checkout, supply the exact official archive described by the
manifest through `BENSON_WHATSAPP_ARCHIVE`. The installed profile also needs a
public npm cache through `BENSON_WHATSAPP_NPM_CACHE`; neither recovery artifact is
in Git. Prepare that cache in a disposable directory with no host npm settings or
credentials and no package scripts. These peer/omit flags match the native managed
installer; they prepare public dependencies only and grant no install trust:

```sh
proof_seed=$(mktemp -d /tmp/benson-whatsapp-repro-XXXXXX)
mkdir -p "$proof_seed/home" "$proof_seed/project" "$proof_seed/cache"
touch "$proof_seed/user.npmrc" "$proof_seed/global.npmrc"
env -i PATH=/usr/bin HOME="$proof_seed/home" \
  NPM_CONFIG_USERCONFIG="$proof_seed/user.npmrc" \
  NPM_CONFIG_GLOBALCONFIG="$proof_seed/global.npmrc" \
  npm install --prefix "$proof_seed/project" --cache "$proof_seed/cache" \
  --ignore-scripts --legacy-peer-deps --omit=dev --omit=peer --no-audit --no-fund \
  --fetch-retries=0 --fetch-timeout=30000 --registry=https://registry.npmjs.org \
  @openclaw/whatsapp@2026.10.10
export BENSON_WHATSAPP_NPM_CACHE="$proof_seed/cache"
```

With the matching OpenClaw dependency installed, build and run the bounded TS05
product profile:

```sh
node --test --test-name-pattern='isolated product entries' \
  output/typescript/integrations/openclaw/benson-routing/tests/whatsapp-response-delivery.test.js
```

The other historical profiles in that file include the separate Core/SDK receipt
exception and agentic flows; they are not qualified for this no-Run release.
Focused Controller/monitor/Request proofs use the isolated qualification harness
recorded in Plan §11.62, with receipt injection disabled. Missing cache/archive, offline misses or any
version/integrity mismatch fail; there is no online fallback inside the proof.
Local defaults reuse the slice checkpoints. Only `_cacache` is mounted read-only;
npm logs/settings are excluded. The installed profile uses the original native
CLI offline in disposable namespaces, verifies genuine npm provenance, applies
the exact patch to that ephemeral installed artifact, and tests the real monitor
and native plugin retirement. Never substitute copied trust/install records.

The existing native runtime-context registry carries an account-scoped
`benson.response-controller.v1` binding. `createTurn({ctx,cfg,replyOptions})` is
synchronous and returns `{resolve, beforeNativeDeliver}`. `resolve` receives a
closure over the original native resolver and its exact arguments, plus a frozen
second argument `{ctx, abortSignal}` from that final native resolver invocation.
Only the wrapper is frozen; native context/options remain untouched and every
original argument, including opaque native fields, is forwarded unchanged.
Existing consumers may ignore the additive argument. Consumers depending on its
native currentness must reject missing/aborted signals or mismatched context and
revalidate before disclosure/delivery. The signal is not domain permission,
durable replay eligibility or evidence of terminal retirement after settlement.
No Source Admission fields are reinterpreted. Direct pure-read integration uses
the separately approved explicit v3 profile; deployment and other direct flows
remain gated by their actual authority and acceptance evidence.
The consumer composes the existing Response owner, including native metadata copying. The final gate
returns the same approved payload or `null` synchronously. Missing/invalid or
retired bindings, unavailable authorization and cancellation block delivery.
Invalid asynchronous factories/gates are denied synchronously and their Promise
rejections are consumed; they must not escape into the host's fatal rejection policy.
The binding is not business authority: the existing source/domain/Completion
owners must supply and revalidate their real custody. A production binding is
not installed or established by the fixture.

The official plugin retains registration, identity, listener, reconnect,
lifecycle, formatting and transport. The proof exports private artifact symbols
in memory for test visibility only, runs actual native dispatch and WhatsApp
delivery. Monitor profiles substitute the socket only, retaining the native
listener, identity, ingress and lifecycle; all receipts remain synthetic memory
receipts. No profile proves real server delivery, authentication, restart/recovery
or universal OpenClaw enforcement. These proofs cannot close TS03 alone.

Upgrade maintenance: obtain a compatible official artifact, inspect the changed
assembly, preserve previous recovery, regenerate only the approved insertion,
and repeat the isolated matrix plus independent review before requesting any
deployment. Replace this patch with an official supported extension/upstream
integration under the explicit Phase 2 backlog item. Restoring source or files
cannot undo messages. Qualification sends no external messages; production channel
actions require separate action-time approval.
