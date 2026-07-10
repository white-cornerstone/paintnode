# Workflow Board 2.0 architecture

Status: Proposed foundation
Updated: 2026-07-10

## Current constraints

The current workflow implementation has valuable product behavior but a fixed
execution model:

- Asset nodes feed one composition node.
- The composition contains the prompt, storyboard, annotations, and AI run
  options.
- One or more output nodes select dimensions and receive generated assets.
- Connections are visually general, but generation interprets only the
  asset-to-composition-to-output path.
- Workflow state, persistence, graph behavior, and substantial editor behavior
  are concentrated in a large Svelte store and component.
- There is no focused workflow graph, serialization, migration, or scheduling
  test suite.

Adding many visual node types before defining execution semantics would create
misleading flexibility and make the current component difficult to evolve.

## Target boundaries

### Framework-independent domain

Create a plain TypeScript workflow domain under `src/lib/workflow/` containing:

- graph types and schema validation;
- node and port definitions;
- connection compatibility and cycle validation;
- graph mutations;
- dirty/stale propagation;
- execution planning;
- persistence and migrations;
- run provenance and cache keys.

This layer must not import Svelte or browser canvas APIs.

### Reactive UI adapter

The Svelte store owns selection, viewport, panels, and reactive presentation.
It delegates graph mutations and execution planning to the domain layer.

### Node UI components

Each creator-level node type has a focused component registered through a node
definition. The board owns common chrome, selection, ports, connections, and
run-state presentation.

The framework-independent creator node registry is the source of truth for the
six creator-facing node definitions: labels, descriptions, search terms,
default geometry and configuration, named typed ports, validation, and executor
capability/availability metadata. Definitions must be unique; registry
construction rejects duplicate node types instead of accepting `Map`
last-write-wins behavior.

Persisted `WorkflowGraph v2` nodes remain authoritative after creation. Registry
defaults seed a newly added node, but they do not rewrite saved titles,
geometry, ports, configuration, or unknown future-node payloads when a workflow
is reopened. Templates may use the same factory while supplying their existing
persisted values; their v2 output is kept under exact golden compatibility
tests.

The searchable node palette and board components own presentation and keyboard
focus behavior. They consume registry metadata without importing or invoking a
provider. The board may retain focused creator UI for established Input, Brief,
Art Direction, and Output experiences while using shared registry metadata and
common chrome; Transform and Review can use the generic creator card until a
focused component is justified.

The board renders one physical handle for every persisted named port. Connection
gestures carry the exact source and target `nodeId` plus `portId`; presentation
must not collapse several ports into one inferred handle. Repeated palette adds
use deterministic open placement rather than identical centre stacking. The
persisted node size is also the rendered card frame used by ports, the map, and
placement; content that exceeds that frame scrolls internally. When no visible
slot remains, the board recentres the newly added node before moving focus to it.

Persisted unsupported future nodes are projected as visible, non-runnable
fallback cards and remain excluded from the creator palette. Their raw payload,
ports, and configuration stay authoritative for saving even though the current
version cannot connect or execute them.

Executor availability has explicit semantics:

- `not-required`: the node records direction, input, review-independent
  metadata, or delivery intent and has no direct Run action;
- `available`: an execution adapter for the declared capability is wired and
  may expose Run when graph readiness also permits it;
- `draft-only`: the node is safe to create and persist, but Run stays disabled
  with a creator-facing reason until its adapter exists.

Provider and model choices are configuration of a Transform node's advanced
controls, not registry node types or palette entries. Capability metadata does
not itself import an adapter or cause execution side effects.

### Execution adapters

Node executors call existing PaintNode AI, image-processing, project-asset, and
document services through explicit interfaces. Executors do not directly
manipulate UI state.

The framework-independent Transform executor receives a detached request made
from persisted graph data: Brief, Art Direction, Transform configuration,
materialized Input assets, and the requested Output contract. It has no Svelte,
editor, Tauri, picker, authentication, filesystem, or network imports. Those
effects are injected at the boundary so the entire path can run with a fake
executor and in-memory asset store.

Persisted storyboard intent is part of that request rather than incidental UI
state. Its data URL or project-relative ORA reference, canvas metadata,
annotations, annotation items, visibility, and provider-neutral placement
constraints are detached with the graph snapshot. The UI boundary materializes
the persisted visual into PNG bytes; adapters send it before other visual
inputs and keep the authored spatial constraints in the prompt without exposing
pixel dimensions.

Provider-specific adapters live outside `src/lib/workflow/`. Codex and
Antigravity adapters translate the same request into their existing composition
services, skip AI Director for the first thin slice, pass target shape through
provider parameters, and normalize the returned raster to the exact configured
Output dimensions before it is stored. A stored result with missing or wrong
dimensions is rejected and does not replace the graph's previous accepted
output.

A Transform's persisted `advanced.provider`, `advanced.model`, and recognized
`advanced.options` override current UI defaults. The executor selects only the
matching provider adapter; it never falls back silently. Boundary-owned values
such as project path, run identity, and Director mode cannot be replaced by a
saved options object.

### Campaign Composer thin-slice path

The first executable path is deliberately narrow:

`Product / optional Subject / optional Style -> Brief -> Art Direction -> Generate Transform -> Square Output`

Only Square Output uses the Generate Transform in this slice. Portrait and
Landscape remain structurally present for later branches. Saved v2 graphs that
connect Art Direction directly to an Output continue to validate, serialize,
and reopen, but that legacy direct edge cannot invoke the new Transform
executor.

The UI store owns transient queued/running progress and commits terminal
cancelled, failed, or successful run records atomically. Progress events are
runtime-only, sanitized, strictly sequenced, and routed by the complete
workflow-session, workflow, run, and node identity; they are never serialized.
Per-Transform run tokens prevent an older overlapping run from overwriting a
newer result. Before
binding, the store rechecks the workflow session identity, domain and reactive
graph revisions, active run token, and project identity captured at start. A
workflow edit, open/new/close action, project switch, or newer run makes the
result non-committable; the current graph is preserved and the board cannot
announce success.

Cancellation aborts the executor signal synchronously and closes progress
routing before asking the provider to terminate. Provider termination is
hard-bounded; failure or timeout becomes a safe detach, and the detached
promise's late progress, output, or failure is ignored. Opening a different
workflow or starting a newer attempt applies the same abort-and-detach rule.
Retry creates a new attempt linked to the latest failed or cancelled attempt on
the same node and preserves all earlier accepted outputs. A legacy persisted
`running` record is normalized on load or serialization to a stable failed
attempt with the creator-safe `INTERRUPTED` recovery message. New executions do
not persist a running record, so saving during execution cannot reopen into a
permanent spinner.

Placing the
Square result is a separate editor action and reports success only when the
editor returns a real inserted layer identifier; an absent active document is
surfaced as a recovery action rather than a false success.

Progress observation must not delay that baseline capture. The board starts
listener registration, invokes the store run synchronously before awaiting the
listener, and disposes the listener after the run even when registration
resolves late. Target, assets, provider adapters and options, project path, and
project identity are therefore snapshots of the click that started the run.

The isolated native `provider-free` QA bundle may expose one visibly labelled
`QA Fake` executor for manual state-path validation. Native mode resolution must
complete before Generate is enabled. The fake returns only a deterministic
Square PNG, uses metadata-only inputs, and writes solely through the normal
project result store. Its Rust command rejects normal and `provider-e2e` modes;
those modes never construct or advertise the fake executor.

## WorkflowGraph v2

The persisted graph should contain:

- `version` and migration metadata;
- graph identity and display metadata;
- typed nodes with position, size, configuration, and exposed recipe controls;
- typed edges connecting named ports;
- references to project assets and optional portable bundled assets;
- run records and selected outputs;
- viewport state as presentation metadata.

Runtime-only state such as active promises, transient progress messages, and
open editor sessions must not be serialized.

## Creator-level node vocabulary

The MVP uses a deliberately small set:

| Node | Purpose |
| --- | --- |
| Input | Image, mask, layered document, or reusable project asset with a semantic role. |
| Brief | Creative objective, constraints, brand direction, and output intent. |
| Art Direction | Storyboard, layout, annotations, and composition requirements. |
| Transform | Generate, edit, remove background, relight, upscale, or another capability selected through configuration. |
| Review | Human or AI quality gate that compares and promotes candidates. |
| Output | Final format, size, filename, placement, and export behavior. |

Provider-specific controls belong inside a Transform node's advanced settings,
not as top-level model plumbing by default.

## Typed ports

Initial port data types:

- `image`
- `image-collection`
- `mask`
- `prompt`
- `layout`
- `layered-document`
- `asset-reference`
- `review-decision`

Connections are directional and type-compatible. The graph is acyclic for the
MVP. A later iteration may add bounded iteration explicitly rather than
allowing accidental cycles.

## Execution model

1. Validate the graph and required inputs.
2. Calculate the upstream dependency closure for the requested node or output.
3. Hash material inputs, node configuration, executor version, and relevant
   provider settings.
4. Reuse a successful cached result when the hash matches.
5. Execute ready nodes in dependency order, allowing independent branches to
   run concurrently within provider limits.
6. Persist run records and project assets as each node completes.
7. Mark downstream results stale when a material input changes.
8. Never delete an accepted result merely because a new branch or rerun starts.

### Selective planning and execution

Selective execution is a framework-independent two-stage contract:

- **Run this node** plans the selected node and the upstream closure required
  to satisfy it. An exact reusable result may satisfy an upstream dependency,
  so work behind that cached boundary is not scheduled.
- **Run from here** treats the selected node and every reachable downstream
  node as affected work. It also includes side-branch upstream dependencies
  required by a reachable merge or configured Output.

The planner receives a detached snapshot of the current material key for every
unblocked `available` node. These are the same keys persisted by the provenance
contract;
the selective planner does not calculate a second cache identity. A persisted
successful run is reusable only when its material key matches exactly and the
caller explicitly verifies that every referenced output artifact is still
available and current. Missing verification, an exception while checking, a
missing artifact, an invalid key, or a mismatched key is a cache miss. There is
no process-global cache or separate trust metadata.

Preflight reports the active execution frontier in stable graph order:

- `planned` is satisfied structural context or has no reusable result;
- `cached` has an exact verified result and will be reused;
- `stale` has a successful result for different material and will execute;
- `blocked` cannot execute, with a missing-input, disabled-node, unsupported,
  or upstream-blocked recovery reason.

Every preflight entry also says whether it will produce an executor call.
Registry disposition is explicit: `not-required` nodes such as Input, Brief,
Art Direction, and Output remain visible as satisfied material context;
`available` capability nodes may execute or reuse a result; and `unavailable`
capability nodes block with their creator-facing recovery reason. A normal
Campaign output run therefore executes Generate, not every structural node on
the path. Planning continues through a propagated blocker so preflight exposes
the disabled or missing-input root cause as well as affected downstream nodes.
The default disposition is derived from the creator registry and the node's
configured capability. A Transform cannot execute merely because its node type
is `transform`: the configured capability must match the registry's available
capability. A boundary may inject a stricter disposition, but unsupported Edit,
Relight, or Remove Background configurations remain blocked until their real
executor is registered.
Execution restrictions are monotonic: they may demote or disable a
registry-available capability, but cannot promote `draft-only`, unsupported, or
`not-required` definitions into executable work.
Trusted boundary code normalizes detached restriction data into an opaque
branded value. The planner accepts only that value and reads its internal
snapshot by identity, without reflecting on caller objects. A proxy around the
opaque value is rejected as an invalid boundary value without invoking its
prototype, key, or descriptor traps.

Planning never mutates run history. A material change is represented by the
new current key, so only that node and downstream nodes whose own keys changed
become stale. Successful or accepted results on unrelated branches remain
available.

### Review promotion boundary

A Review node is a semantic cache boundary, not an executor and not a shortcut
to the newest Transform run. It accepts candidate branches from exactly one
Transform and may feed exactly one Output. Zero, ambiguous, or reconnected
paths remain recoverably blocked until the graph is repaired.

Promotion appends an immutable decision to the workflow-level
`reviewPromotions` ledger. The decision snapshots the Review node revision,
candidate lineage, exact run, asset reference, project-relative path, content
hash, material key, and prior decision identity. Re-promotion appends another
decision and preserves every earlier decision, candidate, and retry. Candidate
run outputs are never mutated with `acceptedAt`.

The latest decision is reusable only after the application boundary:

1. prepares the currently connected Transform material and proves it still
   matches the promoted candidate;
2. re-reads the promoted project asset and proves its identity, path, bytes,
   and SHA-256 hash match the decision;
3. proves the decision's source Transform is still the Transform connected to
   this Review; and
4. confirms the workflow, project, and asset snapshot did not drift during
   verification.

Verification is also scoped to an explicit execution-options identity:
provider, caller identity, project, asset fingerprint, and sorted executor
capability/version descriptors. Overlapping refreshes use a per-Review
monotonic sequence. A superseded refresh cannot mutate shared Review state,
and selective planning consumes the exact frozen snapshot returned by its own
refresh rather than rereading a mutable global result. The Board checklist and
Generate preflight use this same verified resolution and fail closed while no
current snapshot exists.

Until all checks pass, the Review reports a recoverable stale, missing, or
unavailable state. Selective planning must not install the Review cached result,
consume the asset, or schedule the upstream Transform as an implicit bypass.
When verification passes, the exact promoted asset-reference ID is injected as
the Review result and traversal stops there. Its downstream material key hashes
the Review revision and exact promoted run/output/content hash. Consequently,
re-promotion stales only dependent downstream work; it does not stale or erase
the candidate branch history.

Running an Output connected through Review uses this selective cached-result
path and never schedules the upstream Transform. Board preview and placement
derive from the current verified Review result rather than copying the choice
into mutable Output configuration. Direct Transform-to-Output paths retain the
normal Generate behavior.

The scheduler receives the global concurrency limit, provider key mapping, and
per-provider limits from its boundary. It starts independently ready nodes in
stable graph order. A failed executor blocks only dependent pending nodes;
already-ready unrelated work continues and is returned with the failure and
blocked-node outcome. Raw executor errors are replaced by a safe generic
failure unless the boundary injects a validated sanitizer. Zero, missing, or
invalid provider capacity is a configuration error raised before the first
executor call, and exceptions from provider mapping are converted to the same
stable safe boundary without exposing paths, credentials, or adapter details.
Provider limits are read, validated, and checked for consistency for every
planned executor during this preflight, then scheduling uses only the detached
snapshot. A stateful getter or proxy cannot change capacity after validation.

Executor results are accepted only as the exact `{ cacheKey, outputIds }`
shape, with the planned key, unique nonblank identities, no cross-node identity
collision, and an injected ownership check proving that every output belongs
to the current node and project. Extra metadata and foreign output identities
are failures. Each executor-owned result is detached and deeply frozen exactly
once before shape, material, collision, or ownership validation; every later
decision and the committed result use only that snapshot. Stateful getters or
proxies cannot change a value between validation and commit. The returned
outcome strictly projects those fields into another detached deeply frozen
snapshot; callers cannot mutate result arrays, failure records, or outcome
collections after execution.

Progress and cancellation remain owned by the adjacent runtime work. That
integration should wrap the injected node executor and consume the plan and
outcome; it must not duplicate closure, cache, preflight, or scheduling rules
inside UI state. The selective foundation has no Svelte, provider, network,
filesystem, editor, or computer-use dependency.

Node states:

- `blocked`
- `ready`
- `running`
- `succeeded`
- `failed`
- `stale`
- `cancelled`

## Provenance

Every image-producing run records:

- node and workflow revision;
- source asset identifiers and content hashes;
- prompt and structured constraints;
- provider, model, and effective run options;
- executor/schema version;
- start/end timestamps and status;
- produced asset identifiers;
- review decision and promoted candidate, when applicable.

Provenance supports debugging and reproducibility. Provider-internal traces
remain governed by PaintNode's existing debug-artifact setting.

Candidate comparison exposes the recorded Brief, Art Direction, provider/model,
source assets, run identity, terminal state, and availability. Keyboard focus
uses a roving tab stop: Left/Right cycle, Home/End jump, and focus follows the
newly selected candidate. Stable `tab`/`tabpanel` relationships keep the active
provenance context explicit to assistive technology. Promotion is always an
explicit labelled action; selection alone never changes workflow history.

## Persistence and migration

- Continue opening WorkflowFile v1.
- Implement a pure `migrateV1ToV2` conversion with fixture tests before the UI
  starts writing v2 files.
- Preserve the user's original file until the migrated workflow is explicitly
  saved.
- Keep JSON as the inspectable manifest.
- Add an optional portable `.cxflow` bundle later for the manifest and selected
  assets; project-relative references remain the default for normal projects.
- Unknown future node types must produce a recoverable unsupported-node state,
  not data loss.

## Accessibility requirements

- All graph operations must be available without precision pointer input.
- Keyboard users can add, select, move, connect, disconnect, and run nodes.
- Focus order follows the logical graph or an explicit node list, not arbitrary
  canvas coordinates alone.
- Run, failure, stale, and completion changes use accessible status messaging.
- Ports and controls meet target-size and contrast requirements.
- Recipe mode provides a conventional form-like alternative to graph
  interaction for repeat runs.

## Test strategy

Start test-first with pure domain coverage:

1. schema parsing and invalid-data recovery;
2. v1-to-v2 migration fixtures;
3. typed connection and cycle validation;
4. graph mutation invariants;
5. dependency planning and branch concurrency;
6. stale propagation and cache keys;
7. run-state transitions and failure recovery;
8. serialization round trips and forward-compatible unknown nodes.
9. selective closures, exact cache hit and miss behavior, stale isolation,
   disabled blockers, deterministic ready order, provider concurrency, and
   branch-local executor failure.

Browser tests should then cover the Campaign Composer happy path, keyboard
graph operations, node editing, branch comparison, and reopening a saved
workflow.

Before browser automation is added, the Campaign Composer thin slice is covered
through a pure fake-executor integration test that proves readiness, exact
dependency planning, source materialization, execution, project-asset binding,
serialization, and reopen without provider, authentication, picker, network,
filesystem, editor, or Svelte side effects.

## Decisions to validate during Foundation

- Whether run history lives entirely in the workflow manifest or in project
  task records referenced by the manifest.
- Whether the first v2 save remains `.cxflow.json` or introduces the bundle
  extension immediately.
- The exact contract for opening a node result as a layered document and
  returning edits to the graph.
- Which Transform capabilities ship in the MVP beyond generation and upscale.
