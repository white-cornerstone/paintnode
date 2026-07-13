import { describe, expect, it } from 'vitest';
import boardSource from '../components/WorkflowBoard.svelte?raw';
import titleSource from '../components/workflow/WorkflowNodeTitle.svelte?raw';
import toolOptionsSource from '../components/ToolOptions.svelte?raw';

describe('workflow node header UI contract', () => {
  it('keeps canvas node titles static and gives every node the same name-then-type format', () => {
    const renderedTitles = boardSource.match(/<WorkflowNodeTitle\b/g) ?? [];
    const renderedTypeLabels = boardSource.match(/\btypeLabel=/g) ?? [];

    expect(renderedTitles).toHaveLength(6);
    expect(renderedTypeLabels).toHaveLength(renderedTitles.length);
    expect(boardSource).toContain('typeLabel="Asset"');
    expect(boardSource).toContain('typeLabel={briefCreatorDefinition.label}');
    expect(boardSource).toContain('typeLabel={definition.label}');
    expect(boardSource).toContain('typeLabel="Unsupported"');
    expect(boardSource).toContain('typeLabel="Composition"');
    expect(boardSource).toContain('typeLabel="Output"');
    expect(boardSource).not.toContain('node-title-prefix');

    expect(titleSource).toContain('{name || fallback}');
    expect(titleSource).toContain('{typeLabel}');
    expect(titleSource).not.toMatch(/<button|<input|onclick|onCommit|Rename node|Edit node name/);
  });

  it('keeps renaming in the contextual Name field without showing redundant Type info', () => {
    expect(toolOptionsSource).toContain('class="node-name"');
    expect(toolOptionsSource).toContain('workflow.setSelectedLabel(event.currentTarget.value)');
    expect(toolOptionsSource).not.toContain('selectedKindLabel');
  });
});
