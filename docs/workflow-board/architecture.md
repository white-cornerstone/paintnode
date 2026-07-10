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

### Execution adapters

Node executors call existing PaintNode AI, image-processing, project-asset, and
document services through explicit interfaces. Executors do not directly
manipulate UI state.

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

Browser tests should then cover the Campaign Composer happy path, keyboard
graph operations, node editing, branch comparison, and reopening a saved
workflow.

## Decisions to validate during Foundation

- Whether run history lives entirely in the workflow manifest or in project
  task records referenced by the manifest.
- Whether the first v2 save remains `.cxflow.json` or introduces the bundle
  extension immediately.
- The exact contract for opening a node result as a layered document and
  returning edits to the graph.
- Which Transform capabilities ship in the MVP beyond generation and upscale.
