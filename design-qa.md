# Workflow Board Chrome Design QA

- Source visual truth: `/var/folders/l9/8btqqk2j4gx2985784drkf040000gn/T/codex-clipboard-8c4ee6f8-6794-4e20-9ace-4c063fa9de04.png`
- Supporting panel reference: `/var/folders/l9/8btqqk2j4gx2985784drkf040000gn/T/codex-clipboard-c804aa0e-5b52-4201-9358-a607a2ba0bdd.png`
- Implementation screenshot: `/tmp/paintnode-workflow-ui.png`
- Full-view comparison: `/tmp/paintnode-workflow-comparison.png`
- Focused header comparison: `/tmp/paintnode-workflow-header-comparison.png`
- Viewport: 1280 x 720
- State: dark theme, blank workflow created, one Input node added from the header palette, Properties and Map expanded, Project/Tasks column collapsed to its rail

## Findings

No actionable P0, P1, or P2 differences remain.

- The workflow board reaches the left workspace edge; the image-editing tool dock is absent in workflow board mode.
- Workflow modes and the former Nodes actions are present in the header. The node-action buttons measure 22 x 22 px and have no border or outer frame.
- The duplicate workflow Assets tray is absent. The Project panel remains the project-asset source and routes image activation to `workflow.addAsset` while the workflow board is active.
- Properties and Map share one right-side workflow panel column. The column and the individual panels collapse and reopen through the same visual language as the image workspace.
- The Map remains interactive and updated from 0 to 1 node after adding the Input node.

## Required Fidelity Surfaces

- Fonts and typography: inherited PaintNode desktop UI font and the documented 10-12 px dense control scale are preserved. Header labels and panel headers remain legible without introducing a new type hierarchy.
- Spacing and layout rhythm: removing the 248 px tray and workflow tool dock returns that width to the board. Header controls use a compact 22 px rhythm. The workflow panel column aligns directly beside the board and ahead of the Project rail.
- Colors and visual tokens: existing PaintNode background, border, text, accent, hover, and selected-state tokens are reused.
- Image quality and asset fidelity: no new raster assets, placeholders, custom SVGs, or approximated icons were introduced. Existing Fluent icons and the live workflow-map rendering are used.
- Copy and content: `Nodes`, `Properties`, `Map`, workflow tool labels, and existing AI/property field copy are preserved.

## Interaction And Runtime Checks

- Created a blank workflow.
- Collapsed the workflow panel column and reopened Properties from the collapsed rail.
- Opened the header Add-node palette and added an Input node.
- Confirmed the selected-node Properties content and Map node count updated.
- Confirmed the legacy left toolbar is not rendered, the board starts at x=0, and the header fills the viewport width.
- Checked browser console output. The browser-only preview reports the existing Tauri event bridge initialization error from `AiDirectorInputDialog`; it is outside the changed workflow chrome and did not affect the verified interactions.
- Project-backed asset activation is desktop-only and was not available in the browser preview; its workflow routing is covered by the updated source-contract test.

## Comparison History

- Initial implementation comparison: no P0/P1/P2 visual mismatch found. The annotated removals, header relocation, and new workflow panel column are all visible in the combined comparison, so no post-capture visual correction loop was required.

## Follow-up Polish

No P3 follow-up is required for this pass.

final result: passed
