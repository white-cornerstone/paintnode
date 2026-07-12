# Creative Blueprint delivery roadmap

Updated: 2026-07-10

## Operating model

Use repository documents and GitHub together:

- These documents hold stable product intent, architecture, research, and
  release gates.
- GitHub milestones hold independently shippable phases.
- GitHub issues hold scoped outcomes, acceptance criteria, dependencies, and
  implementation evidence.
- Pull requests implement one issue or one coherent vertical slice and link to
  the issue they close.
- GitHub issue state is the only live progress tracker; do not maintain a
  duplicate checklist in Markdown.

A GitHub Project board is unnecessary initially. Add one only when several
contributors or repositories need a shared scheduling view that milestones
and issue filters no longer provide.

## GitHub execution

- Umbrella tracker: [#57](https://github.com/white-cornerstone/paintnode/issues/57)
- Foundation milestone: [milestone 1](https://github.com/white-cornerstone/paintnode/milestone/1)
- Creative Blueprint MVP: [milestone 2](https://github.com/white-cornerstone/paintnode/milestone/2)
- Recipes & Portability: [milestone 3](https://github.com/white-cornerstone/paintnode/milestone/3)

Foundation issues, in dependency order:

1. [#58 — WorkflowGraph v2 schema and v1 migration](https://github.com/white-cornerstone/paintnode/issues/58)
2. [#59 — Framework-independent workflow domain](https://github.com/white-cornerstone/paintnode/issues/59)
3. [#60 — Typed ports, validation, and cycle prevention](https://github.com/white-cornerstone/paintnode/issues/60)
4. [#61 — Execution planning, node states, and stale propagation](https://github.com/white-cornerstone/paintnode/issues/61)
5. [#62 — Reactive UI adapter integration](https://github.com/white-cornerstone/paintnode/issues/62)
6. [#63 — Unified onboarding and real templates](https://github.com/white-cornerstone/paintnode/issues/63)

## Milestone 1 — Workflow Board 2.0: Foundation

### Outcome

PaintNode has a tested, typed, versioned workflow domain that can support real
execution semantics without breaking existing workflow files.

### Deliverables

- WorkflowGraph v2 schema and v1 migration.
- Framework-independent graph domain.
- Typed ports, compatibility checks, and cycle prevention.
- Node run states, dependency planning, stale propagation, and cache keys.
- Workflow fixtures and focused unit tests.
- Unified workflow onboarding with real templates and explicit project setup.

### Exit gate

An existing v1 workflow migrates and reopens without data loss; a v2 Campaign
Composer fixture validates, serializes, computes execution order, and reports
stale downstream nodes through pure tested code.

## Milestone 2 — Creative Blueprint: MVP

### Outcome

A creator can complete the Campaign Composer flagship workflow from inputs to
editable multi-format outputs.

### Deliverables

- Creator-level node registry and node palette.
- AI Director workflow drafting and constrained graph revision.
- Branch generation, visual comparison, and candidate promotion.
- Selective node and downstream execution.
- Run provenance, progress, cancellation, and failure recovery.
- Open a node result in the editor and return the edited result.
- Campaign Composer template with guided activation.

Selective execution is delivered as a pure planner and injected scheduler.
Progress and cancellation integrate around that executor boundary; they do not
reimplement dependency closure, preflight, cache reuse, provider limits, or
failure propagation in the board store.

### Exit gate

A new user can complete the flagship workflow without manually constructing a
technical model graph, and changing an upstream input reruns only affected
downstream work.

Issue #85 supplies the integrated provider-free draft evidence in
`src/lib/workflow/campaignComposerFlagshipAcceptance.test.ts` and the manual
native scenario in `docs/testing/native-qa.md`. The amended gate requires both
a configured-provider run and an owner-observed validation program with 6–8
isolated AI-assisted creator sessions, manual checkpoint review, de-identified
records, and an explicit blocker classification. These sessions are synthetic
product evidence and must not be represented as human-creator research.
Passing unit, Rust, or build checks alone must not be reported as milestone exit.
The validation program is documented in the
[Creative Blueprint creator study protocol](../testing/creative-blueprint-creator-study.md).

## Milestone 3 — Recipes & Portability

### Outcome

Successful workflows can be reused reliably by their creator or another
PaintNode user without exposing unnecessary graph complexity.

### Deliverables

- Recipe mode with explicitly exposed controls.
- Portable workflow manifest and optional asset bundle.
- Output families and batch input sets.
- Curated template gallery.
- Requirement validation and recoverable unsupported-node states.
- Keyboard and assistive-technology completion.
- Performance hardening for larger boards.

### Exit gate

A creator packages Campaign Composer as a recipe, another user opens it,
replaces the exposed inputs, produces all configured outputs, and can inspect
the underlying graph when needed.

## Later opportunities

Create new milestones only after the first three exit gates are met:

- team review and live collaboration;
- community template distribution;
- video, audio, and 3D workflows;
- third-party node or plugin ecosystem;
- cross-repository marketing and example-project rollout.

## Issue contract

Every implementation issue includes:

- user or architectural outcome;
- why it belongs in the current milestone;
- acceptance criteria;
- required automated and manual validation;
- dependencies;
- explicit non-goals;
- documentation or migration impact.

Prefer issues that can merge independently in several days. Split work when a
single issue combines domain design, major UI construction, provider
integration, and migration risk.

## Delivery sequence

1. Merge the planning documents.
2. Implement the Foundation issues test-first in dependency order.
3. Review the v2 schema and migration using real saved workflow fixtures.
4. Build one thin Campaign Composer vertical slice before expanding node types.
5. Validate the MVP interaction with 6–8 isolated AI-assisted creator sessions under owner-observed manual checkpoint review; keep human creator research separate.
6. Complete the remaining MVP behaviors based on observed friction.
7. Begin Recipes & Portability only after selective execution and editor
   round-tripping are reliable.

## First MVP vertical slice

The original Product-to-Square thin slice remains a supported saved-graph
shape. New Campaign Composer and equivalent Director drafts now instantiate the
flagship topology: Generate Concepts, human Review, accepted Square, and
Portrait/Landscape adaptations from the exact effective Review result. The
provider-free executor covers all three configured shapes before configured
provider evidence is attempted.
