import { describe, expect, it } from 'vitest';
import layersPanelSource from '../components/LayersPanel.svelte?raw';
import propertiesPanelSource from '../components/PropertiesPanel.svelte?raw';

describe('layer metadata UI mutation contract', () => {
  it('routes Properties panel metadata edits through tracked EditorStore setters', () => {
    expect(propertiesPanelSource).toContain('editor.setLayerName(layer, value)');
    expect(propertiesPanelSource).toContain('editor.setLayerOpacity(layer,');
    expect(propertiesPanelSource).toContain('editor.setLayerBlendMode(layer,');
    expect(propertiesPanelSource).not.toContain('layer.name =');
    expect(propertiesPanelSource).not.toContain('layer.opacity =');
    expect(propertiesPanelSource).not.toContain('layer.blendMode =');
  });

  it('routes Layers panel rename through the same tracked setter', () => {
    expect(layersPanelSource).toContain('editor.setLayerName(l,');
    expect(layersPanelSource).not.toContain('l.name =');
  });
});
