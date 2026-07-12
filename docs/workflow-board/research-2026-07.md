# Workflow-board market research

Research date: 2026-07-10

## Executive conclusion

Node-based creative workflows are becoming a market baseline. Figma Weave,
Krea, Runway, Freepik Spaces, FLORA, ComfyUI, and InvokeAI all validate reusable
visual pipelines. The differentiator is shifting from whether a product has a
graph to how workflows are authored, understood, refined, shared, and brought
to a professional finish.

PaintNode should not enter a model-catalog arms race. Its strongest opportunity
is the combination it already owns: a spatial workflow board, a real layered
raster editor, editable storyboards and annotations, local project assets, an
AI Director, provider choice, and portable files.

## Competitive map

| Product | Strongest capability | Strategic lesson for PaintNode |
| --- | --- | --- |
| Figma Weave | Multi-model workflows, professional media tools, branching, workflow-to-tool publishing, and Figma Community distribution | Reuse and progressive disclosure are mandatory; community reach is a long-term moat, not the first battle. |
| Krea Nodes | Reusable image/video workflows and natural-language workflow generation | The AI Director should be able to draft and revise a small readable board. |
| Runway Workflows | Reusable multi-modal production pipelines and templates | Templates must represent real production jobs, not starter copy. |
| Freepik Spaces | Collaborative canvases, contextual comments, templates, selective node and downstream execution | Selective reruns, history, and clear execution scope are expected. |
| FLORA | Visible creative decision systems and collaboration | Preserve reasoning and creative lineage, not only final files. |
| ComfyUI | Deep flexibility, local execution, and an extensive ecosystem | Avoid unreadable graphs, node overload, broken dependencies, and fragile sharing. |
| Adobe Firefly Boards | Low-friction ideation and Adobe handoff | Keep the entry experience visual and make professional finishing seamless. |
| InvokeAI | Workflow results can be reviewed and accepted on the editing canvas | PaintNode's board-to-editor connection can become a defining advantage. |

## Highest-signal market problems

### 1. Prompt iteration loses structure

Creators need to preserve references, decisions, alternatives, and successful
steps rather than repeatedly reconstructing a prompt. Branching and visible
lineage address this better than chat history alone.

### 2. Powerful graphs become unreadable

Community discussions around ComfyUI consistently identify wire clutter, node
overload, missing node documentation, and graphs that are difficult to learn
from. PaintNode should use a small creator-level vocabulary and progressively
disclose provider details.

### 3. Shared workflows often fail to reproduce

Local extensions, model dependencies, version drift, missing assets, and
implicit settings make many technical workflows fragile. PaintNode needs a
versioned manifest, explicit requirements, deterministic migration, and a
portable bundle option.

### 4. Exploration and finishing are separated

Cloud canvases are strong at generation and collaboration but often hand the
winning output to another editor. PaintNode can keep generation, review,
layered correction, masks, annotations, and downstream reruns in one project.

### 5. Reuse requires a simpler surface

Figma Weave's workflow-to-tool direction and Krea's shareable apps both point
to the same need: an expert builds the graph, while repeat users interact with
only selected inputs and controls. PaintNode should call this Recipe mode.

## Sources

- Figma Weave: https://weave.figma.com/
- Connecting Figma and Weave: https://www.figma.com/blog/connecting-figma-and-weave/
- Krea Nodes: https://docs.krea.ai/user-guide/features/nodes
- Runway Workflows: https://runwayml.com/workflows
- Freepik Spaces: https://www.freepik.com/spaces
- FLORA quickstart: https://docs.flora.ai/getting-started/quickstart
- ComfyUI workflow concepts: https://docs.comfy.org/development/core-concepts/workflow
- ComfyUI readable-node discussion: https://www.reddit.com/r/comfyui/comments/1kjw7c5/readable_nodes_for_comfyui/
- ComfyUI stability and reproducibility discussion: https://www.reddit.com/r/comfyui/comments/1r2ouv9/calling_out_creators_lets_solve_the_biggest_pain/
- Adobe Firefly Boards: https://helpx.adobe.com/firefly/web/create-mood-boards/firefly-boards/about-firefly-boards.html
- InvokeAI canvas workflow: https://invoke.ai/features/canvas/run-workflow/

## Evidence limits

Figma Weave and several direct competitors are changing quickly. Public user
feedback is still sparse and sometimes promotional. This research did not have
PaintNode usage analytics, support tickets, or user interviews. Before the MVP
interaction design is locked, validate Campaign Composer with 6–8 target
creators using task-based prototypes.
