import { describe, expect, it } from 'vitest';
import boardSource from '../components/WorkflowBoard.svelte?raw';
import titleSource from '../components/workflow/WorkflowNodeTitle.svelte?raw';
import toolOptionsSource from '../components/ToolOptions.svelte?raw';
import workflowStoreSource from '../state/workflow.svelte.ts?raw';

describe('workflow node header UI contract', () => {
  it('keeps canvas node titles static and gives every node the same name-then-type format', () => {
    const renderedTitles = boardSource.match(/<WorkflowNodeTitle\b/g) ?? [];
    const renderedTypeLabels = boardSource.match(/\btypeLabel=/g) ?? [];

    expect(renderedTitles).toHaveLength(6);
    expect(renderedTypeLabels).toHaveLength(renderedTitles.length);
    expect(boardSource).toContain("const inputCreatorDefinition = creatorNodeDefinition('input')");
    expect(boardSource).toContain("const artDirectionCreatorDefinition = creatorNodeDefinition('art-direction')");
    expect(boardSource).toContain('typeLabel={inputCreatorDefinition.label}');
    expect(boardSource).toContain('typeLabel={briefCreatorDefinition.label}');
    expect(boardSource).toContain('typeLabel={artDirectionCreatorDefinition.label}');
    expect(boardSource).toContain('typeLabel={definition.label}');
    expect(boardSource).toContain('typeLabel="Unsupported"');
    expect(boardSource).toContain('typeLabel="Output"');
    expect(boardSource).not.toContain('typeLabel="Composition"');
    expect(boardSource).not.toContain('node-title-prefix');

    expect(titleSource).toContain('{name || fallback}');
    expect(titleSource).toContain('{typeLabel}');
    expect(titleSource).not.toMatch(/<button|<input|onclick|onCommit|Rename node|Edit node name/);
  });

  it('uses one inset textarea treatment across workflow node families', () => {
    expect(boardSource).toMatch(/\.asset-node textarea,[\s\S]*\.creator-node textarea\s*\{[^}]*border:\s*1px solid #4b4d52;[^}]*border-radius:\s*4px;[^}]*font:\s*inherit;/);
    expect(boardSource).toMatch(/\.asset-node-body textarea\s*\{[^}]*width:\s*calc\(100% - 16px\);[^}]*margin:\s*8px;/s);
    expect(boardSource).toMatch(/\.brief-node-body\s*\{[^}]*gap:\s*8px;[^}]*padding:\s*9px;/s);
    expect(boardSource).toMatch(/\.prompt-node \.composition-text\s*\{[^}]*width:\s*calc\(100% - 16px\);[^}]*margin:\s*8px;/s);
  });

  it('keeps declared node geometry authoritative and prevents default-width overflow', () => {
    expect(boardSource).toContain('height:${workflow.compositionHeight}px');
    expect(boardSource).toContain('<div class="prompt-node-body">');
    expect(boardSource).toMatch(/\.prompt-node-body\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/s);
    expect(boardSource).toMatch(/\.creator-node-body\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*overflow-x:\s*hidden;/s);
    expect(boardSource).toMatch(/\.candidate-branch-controls\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s);
  });

  it('offers consistent removable-node actions and accessible control sizing', () => {
    expect(boardSource).toContain('workflow.removeNode(brief.id)');
    expect(boardSource).toContain("workflow.removeNode('composition')");
    expect(boardSource).toContain('direction prompt`}');
    expect(boardSource).toMatch(/\.node-head button,[^}]*\.storyboard-head button\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;/s);
    expect(workflowStoreSource).toContain("this.selection?.kind === 'composition' && id === 'composition'");
  });

  it('keeps renaming in the contextual Name field without showing redundant Type info', () => {
    expect(toolOptionsSource).toContain('class="node-name"');
    expect(toolOptionsSource).toContain('workflow.setSelectedLabel(event.currentTarget.value)');
    expect(toolOptionsSource).not.toContain('selectedKindLabel');
  });
});
