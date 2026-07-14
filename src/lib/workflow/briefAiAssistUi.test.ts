import { describe, expect, it } from 'vitest';
import nodeOptionsSource from '../components/workflow/WorkflowNodeAiOptions.svelte?raw';
import propertiesSource from '../components/workflow/WorkflowPropertiesPanel.svelte?raw';

describe('Brief AI assistance UI', () => {
  it('defaults to clear manual wording while keeping workflow and provider choices available', () => {
    expect(nodeOptionsSource).toContain("'Manual · use text verbatim'");
    expect(nodeOptionsSource).toContain("'Manual · text used verbatim'");
    expect(nodeOptionsSource).toContain("'AI assistance'");
    expect(nodeOptionsSource).toContain("directorOnRequest={node.type === 'brief'}");
    expect(nodeOptionsSource).toContain("setBriefAssistMode('workflow-default')");
    expect(propertiesSource).toContain('Manual · use text verbatim');
    expect(propertiesSource).toContain('No AI request is made. The Brief text is passed downstream exactly as written.');
  });

  it('labels enhancement as an explicit AI action', () => {
    expect(propertiesSource).toContain('Enhance with AI…');
  });
});
