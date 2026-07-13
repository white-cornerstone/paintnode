<script lang="ts">
  import { workflow, type WorkflowConnection } from '../../state/workflow.svelte';
  import { workflowBoardViewport } from '../../state/workflowBoardViewport.svelte';
  import {
    clampWorkflowPan,
    workflowMapBounds,
    type WorkflowMapBounds,
    type WorkflowViewportItem,
  } from '../../workflow/viewportGeometry';
  import type { WorkflowNodePort } from '../../workflow';

  type MapKind = 'asset' | 'brief' | 'composition' | 'creator' | 'output' | 'unsupported' | 'viewport';
  type MapRect = WorkflowViewportItem & {
    id: string;
    kind: MapKind;
    color: string;
    included?: boolean;
  };
  type MapModel = { items: MapRect[]; viewport: MapRect; bounds: WorkflowMapBounds };

  const MAP_EDGE_PADDING = 260;
  let dragging = $state<{ offsetX: number; offsetY: number } | null>(null);
  const hasComposition = $derived.by(() => {
    workflow.rev;
    return workflow.graphSnapshot().nodes.some((node) => node.id === 'composition');
  });
  const items = $derived(mapItems());
  const model = $derived(mapModel());

  function mapItems(): MapRect[] {
    return [
      ...workflow.nodes.map((node) => ({
        id: node.id, kind: 'asset' as const, x: node.x, y: node.y,
        width: node.width, height: node.height, color: node.color, included: node.included,
      })),
      ...workflow.briefNodes.map((node) => ({
        id: node.id, kind: 'brief' as const, x: node.x, y: node.y,
        width: node.width, height: node.height, color: node.color,
      })),
      ...workflow.creatorNodes.map((node) => ({
        id: node.id, kind: 'creator' as const, x: node.x, y: node.y,
        width: node.width, height: node.height, color: node.color,
      })),
      ...workflow.unsupportedNodes.map((node) => ({
        id: node.id, kind: 'unsupported' as const, x: node.x, y: node.y,
        width: node.width, height: node.height, color: node.color,
      })),
      ...(hasComposition ? [{
        id: 'composition', kind: 'composition' as const,
        x: workflow.promptX, y: workflow.promptY,
        width: workflow.compositionWidth, height: workflow.compositionHeight,
        color: workflow.compositionColor,
      }] : []),
      ...workflow.outputNodes.map((node) => ({
        id: node.id, kind: 'output' as const, x: node.x, y: node.y,
        width: node.width, height: node.height, color: node.color,
      })),
    ];
  }

  function fallbackBounds(rect: MapRect): WorkflowMapBounds {
    const minX = rect.x - MAP_EDGE_PADDING;
    const minY = rect.y - MAP_EDGE_PADDING;
    const maxX = rect.x + rect.width + MAP_EDGE_PADDING;
    const maxY = rect.y + rect.height + MAP_EDGE_PADDING;
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }

  function viewportRect(): MapRect {
    const zoom = Math.max(0.001, workflow.zoom);
    return {
      id: 'viewport', kind: 'viewport', x: -workflow.panX / zoom, y: -workflow.panY / zoom,
      width: workflowBoardViewport.width / zoom,
      height: workflowBoardViewport.height / zoom,
      color: 'var(--accent)',
    };
  }

  function mapModel(): MapModel {
    const viewport = viewportRect();
    return {
      items,
      viewport,
      bounds: workflowMapBounds(
        items,
        workflowBoardViewport.width,
        workflowBoardViewport.height,
        workflow.zoom,
        MAP_EDGE_PADDING,
      ) ?? fallbackBounds(viewport),
    };
  }

  function mapX(x: number, map: MapModel): number {
    return ((x - map.bounds.minX) / map.bounds.width) * 100;
  }

  function mapY(y: number, map: MapModel): number {
    return ((y - map.bounds.minY) / map.bounds.height) * 100;
  }

  function rectStyle(rect: MapRect, map: MapModel): string {
    const minSize = rect.kind === 'viewport' ? 8 : 5;
    return [
      `left:${mapX(rect.x, map)}%`,
      `top:${mapY(rect.y, map)}%`,
      `width:max(${minSize}px, ${(rect.width / map.bounds.width) * 100}%)`,
      `height:max(${minSize}px, ${(rect.height / map.bounds.height) * 100}%)`,
      `--mini-color:${rect.color}`,
    ].join(';');
  }

  function nodeRect(nodeId: string): WorkflowViewportItem | null {
    if (nodeId === 'composition') {
      return { x: workflow.promptX, y: workflow.promptY, width: workflow.compositionWidth, height: workflow.compositionHeight };
    }
    const output = workflow.outputNode(nodeId);
    if (output) return { x: output.x, y: output.y, width: output.width, height: output.height };
    const node = [
      ...workflow.briefNodes,
      ...workflow.creatorNodes,
      ...workflow.unsupportedNodes,
      ...workflow.nodes,
    ].find((item) => item.id === nodeId);
    return node ? { x: node.x, y: node.y, width: node.width, height: node.height } : null;
  }

  function nodePorts(nodeId: string): { inputs: WorkflowNodePort[]; outputs: WorkflowNodePort[] } {
    workflow.rev;
    return workflow.graphSnapshot().nodes.find((node) => node.id === nodeId)?.ports ?? { inputs: [], outputs: [] };
  }

  function portPoint(nodeId: string, portId: string, side: 'input' | 'output'): { x: number; y: number } | null {
    const rect = nodeRect(nodeId);
    const ports = side === 'input' ? nodePorts(nodeId).inputs : nodePorts(nodeId).outputs;
    const index = ports.findIndex((port) => port.id === portId);
    if (!rect || index < 0) return null;
    return {
      x: side === 'input' ? rect.x : rect.x + rect.width,
      y: rect.y + rect.height * ((index + 1) / (ports.length + 1)),
    };
  }

  function linkStyle(connection: WorkflowConnection, map: MapModel): string {
    const source = portPoint(connection.from, connection.sourcePortId, 'output');
    const target = portPoint(connection.to, connection.targetPortId, 'input');
    if (!source || !target) return 'display:none';
    const x1 = mapX(source.x, map);
    const y1 = mapY(source.y, map);
    const x2 = mapX(target.x, map);
    const y2 = mapY(target.y, map);
    const dx = x2 - x1;
    const dy = y2 - y1;
    return `left:${x1}%;top:${y1}%;width:${Math.hypot(dx, dy)}%;transform:rotate(${Math.atan2(dy, dx) * (180 / Math.PI)}deg)`;
  }

  function point(event: PointerEvent, map: MapModel): { x: number; y: number } | null {
    if (!(event.currentTarget instanceof HTMLElement)) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: map.bounds.minX + ((event.clientX - rect.left) / rect.width) * map.bounds.width,
      y: map.bounds.minY + ((event.clientY - rect.top) / rect.height) * map.bounds.height,
    };
  }

  function contains(rect: MapRect, value: { x: number; y: number }): boolean {
    return value.x >= rect.x && value.x <= rect.x + rect.width
      && value.y >= rect.y && value.y <= rect.y + rect.height;
  }

  function setViewportOrigin(left: number, top: number): void {
    const zoom = Math.max(0.001, workflow.zoom);
    const proposed = { panX: -left * zoom, panY: -top * zoom };
    const next = clampWorkflowPan(
      proposed,
      items,
      workflowBoardViewport.width,
      workflowBoardViewport.height,
      workflow.zoom,
    );
    workflow.panBy(next.panX - workflow.panX, next.panY - workflow.panY);
  }

  function centerAt(x: number, y: number): void {
    setViewportOrigin(
      x - workflowBoardViewport.width / Math.max(0.001, workflow.zoom) / 2,
      y - workflowBoardViewport.height / Math.max(0.001, workflow.zoom) / 2,
    );
  }

  function startDrag(event: PointerEvent): void {
    const value = point(event, model);
    if (!value || !(event.currentTarget instanceof HTMLElement)) return;
    event.preventDefault();
    if (contains(model.viewport, value)) {
      dragging = { offsetX: value.x - model.viewport.x, offsetY: value.y - model.viewport.y };
      event.currentTarget.setPointerCapture(event.pointerId);
    } else {
      centerAt(value.x, value.y);
    }
  }

  function moveDrag(event: PointerEvent): void {
    if (!dragging) return;
    const value = point(event, model);
    if (value) setViewportOrigin(value.x - dragging.offsetX, value.y - dragging.offsetY);
  }
</script>

<div class="workflow-map">
  <button
    class="workflow-map-canvas"
    class:dragging
    aria-label="Workflow map. Drag the viewport frame or click to center the workflow canvas."
    onpointerdown={startDrag}
    onpointermove={moveDrag}
    onpointerup={() => (dragging = null)}
    onpointercancel={() => (dragging = null)}
  >
    {#each workflow.connections as connection (connection.id)}
      <span class="map-link" style={linkStyle(connection, model)}></span>
    {/each}
    {#each model.items as item (item.id)}
      <span
        class="map-node"
        class:asset={item.kind === 'asset'}
        class:brief={item.kind === 'brief'}
        class:composition={item.kind === 'composition'}
        class:creator={item.kind === 'creator'}
        class:output={item.kind === 'output'}
        class:unsupported={item.kind === 'unsupported'}
        class:included={item.included}
        style={rectStyle(item, model)}
      ></span>
    {/each}
    <span class="map-viewport" style={rectStyle(model.viewport, model)}></span>
  </button>
  <div class="map-meta">
    <span>{model.items.length} nodes</span>
    <span>{Math.round(workflow.zoom * 100)}%</span>
  </div>
</div>

<style>
  .workflow-map { display: grid; gap: 6px; padding: 8px 8px 10px; }
  .workflow-map-canvas {
    position: relative;
    display: block;
    width: 100%;
    aspect-ratio: 1;
    min-height: 148px;
    padding: 0;
    overflow: hidden;
    border: 1px solid #3b3d41;
    border-radius: 6px;
    background:
      linear-gradient(rgba(255, 255, 255, 0.045) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, 0.045) 1px, transparent 1px);
    background-color: #202225;
    background-size: 18px 18px;
    cursor: grab;
    touch-action: none;
  }
  .workflow-map-canvas:hover { border-color: color-mix(in srgb, var(--accent) 50%, #3b3d41); }
  .workflow-map-canvas.dragging { cursor: grabbing; }
  .map-node, .map-viewport, .map-link { position: absolute; display: block; pointer-events: none; }
  .map-node {
    border: 1px solid color-mix(in srgb, var(--mini-color) 58%, #65686f);
    border-radius: 3px;
    background: color-mix(in srgb, var(--mini-color) 40%, #4b4d52);
    opacity: 0.78;
  }
  .map-node.asset:not(.included) { opacity: 0.38; }
  .map-node.composition { background: color-mix(in srgb, var(--accent) 28%, #4b4d52); border-color: color-mix(in srgb, var(--accent) 65%, #65686f); }
  .map-node.brief { background: color-mix(in srgb, #a77ad1 30%, #4b4d52); border-color: color-mix(in srgb, #a77ad1 68%, #65686f); }
  .map-node.creator { background: color-mix(in srgb, #59a2c8 28%, #4b4d52); border-color: color-mix(in srgb, #59a2c8 64%, #65686f); }
  .map-node.unsupported { border-style: dashed; background: color-mix(in srgb, #d08b67 22%, #4b4d52); border-color: color-mix(in srgb, #d08b67 65%, #65686f); }
  .map-node.output { background: color-mix(in srgb, #6b7cff 28%, #4b4d52); }
  .map-viewport {
    border: 2px solid var(--accent);
    border-radius: 3px;
    background: color-mix(in srgb, var(--accent) 9%, transparent);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35), 0 0 10px color-mix(in srgb, var(--accent) 32%, transparent);
  }
  .map-link { height: 1px; transform-origin: 0 50%; border-top: 1px solid color-mix(in srgb, var(--accent) 72%, transparent); opacity: 0.66; }
  .map-meta { display: flex; align-items: center; justify-content: space-between; color: var(--text-dim); font-size: 11px; }
</style>
