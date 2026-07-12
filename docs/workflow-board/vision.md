# Creative Blueprint product vision

Status: Draft for implementation
Updated: 2026-07-10

## Product decision

PaintNode will not compete as another generic node editor or model catalog.
It will provide the most direct path from a creative brief to an inspectable,
editable, repeatable image-production workflow.

The working name for this experience is **Creative Blueprint**:

> PaintNode turns a creative brief into a visible production board where every
> AI step can be sketched, annotated, branched, reviewed, selectively rerun,
> and opened as editable layers.

## Primary users

- Independent designers and visual creators combining AI generation with
  hands-on raster editing.
- Small creative and marketing teams producing related campaign assets across
  multiple formats.
- Creators who want local project files and provider choice without adopting a
  low-level diffusion graph or a separate cloud-only workflow system.

The first release is not optimized for VFX pipeline engineers, large live
collaboration teams, or users who want hundreds of model-specific controls.

## Core jobs

1. Compose a new image from subject, product, environment, style, and layout
   references without repeatedly rebuilding prompts.
2. Explore several directions, compare them, and preserve the lineage of the
   chosen result.
3. Correct an intermediate result in the editor, then rerun only the affected
   downstream work.
4. Produce consistent output families such as square, portrait, and landscape
   campaign variants.
5. Save a successful workflow as a reusable recipe with only the necessary
   inputs and controls exposed.

## Product principles

### Art direction over model wiring

Creators work with briefs, references, storyboards, masks, annotations,
variants, and outputs. Provider and model details remain available through
progressive disclosure.

### The graph explains the work

Connections must have real execution semantics. Node state, stale downstream
results, active runs, failures, and cached outputs must be visible and
understandable.

### Fork instead of overwrite

Creative exploration should retain alternatives and decisions. A creator can
branch, compare, promote, and return to earlier results.

### Every result remains editable

Image-producing nodes open in PaintNode's editor and return edited content to
the workflow without export-and-reimport friction.

### Local, portable, and provider-agnostic

Workflow files remain user-owned. A workflow records its requirements and
provenance without depending on a PaintNode-hosted model or billing layer.

### Simple first, deep when needed

Templates, AI-authored boards, and recipe mode handle common jobs. Advanced
users can inspect and change the underlying graph.

## Flagship workflow

The first end-to-end proof is **Campaign Composer**:

1. Add a product image, optional subject reference, and style reference.
2. Describe the campaign brief.
3. Sketch or annotate the required composition.
4. Generate several concept branches.
5. Compare candidates and promote one direction.
6. Refine the selected image as layers in PaintNode.
7. Produce consistent 1:1, 4:5, and 16:9 outputs.
8. Save the board as a reusable recipe with replaceable inputs.

Candidate promotion is an explicit, append-only creative decision. The Review
node compares alternatives with their Brief, Art Direction, and run provenance;
it never silently chooses the newest result. If upstream material or the
promoted project asset changes, the decision becomes recoverably blocked until
the creator verifies and promotes a current candidate. Re-promotion preserves
the earlier direction and alternatives as decision history.

## Initial non-goals

- A general-purpose automation platform.
- A public third-party node/plugin ecosystem.
- Live multiplayer editing.
- Full video, audio, or 3D production.
- Parity with every ComfyUI parameter or model.
- Cloud execution owned or billed by PaintNode.

## Success measures

- Median time from new board to first accepted output.
- Percentage of new boards completing a first run.
- Percentage of workflows reopened or reused within seven days.
- Selective reruns as a share of all workflow reruns.
- Accepted outputs per generation attempt.
- Percentage of generated outputs opened or placed as editable layers.
- Recipes reused with more than one input set or output family.
- Workflow open/migration failure rate.

## Product definition of done

Creative Blueprint is successful when a new user can start from a Campaign
Composer template, understand what each step does, produce and compare
variants, edit the winner, rerun only affected work, and reopen the workflow on
another supported PaintNode installation without reconstructing it manually.
