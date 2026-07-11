import { afterEach, describe, expect, it } from 'vitest';
import {
  bindWorkflowRoundTripAuthority,
  clearWorkflowRoundTripAuthority,
  hasWorkflowRoundTripSessions,
  workflowRoundTripAuthority,
  workflowRoundTripSessionsForWorkflow,
  type WorkflowRoundTripAuthorityInput,
} from './workflowEditorSession';

const hash = `sha256:${'a'.repeat(64)}`;
const authority: WorkflowRoundTripAuthorityInput = {
  id: 'session-authority', workflowId: 'workflow-proxy', workflowSavedPath: 'workflows/proxy.cxflow.json',
  projectIdentity: '1:/project', sessionIdentity: 1, mutationIdentity: 1, storeRevision: 1,
  graphRevision: 1, materialKey: 'material-proxy',
  identity: { nodeId: 'transform', rootRunId: 'run' },
  source: {
    kind: 'run-output', id: 'run', assetReferenceId: 'ref', assetId: 'asset',
    relativePath: 'assets/result.png', contentHash: hash,
  },
};

const sessions: object[] = [];
class TestDocument {}

afterEach(() => {
  sessions.forEach(clearWorkflowRoundTripAuthority);
  sessions.length = 0;
});

describe('workflow editor session authority', () => {
  it('resolves and clears one private capability through raw and Svelte-style proxy identities', () => {
    const raw = { doc: new TestDocument() };
    const proxy = new Proxy(raw, {});
    sessions.push(raw, proxy);

    bindWorkflowRoundTripAuthority(raw, authority);

    expect(workflowRoundTripAuthority(proxy)).toMatchObject({ id: authority.id, workflowId: authority.workflowId });
    bindWorkflowRoundTripAuthority(proxy, { ...authority, id: 'session-authority-rebound' });
    expect(workflowRoundTripAuthority(raw)?.id).toBe('session-authority-rebound');
    expect(workflowRoundTripSessionsForWorkflow(authority.workflowId)).toHaveLength(1);
    expect(hasWorkflowRoundTripSessions()).toBe(true);
    clearWorkflowRoundTripAuthority(proxy);
    expect(workflowRoundTripAuthority(raw)).toBeNull();
    expect(hasWorkflowRoundTripSessions()).toBe(false);
  });

  it('keeps the capability non-enumerable and prevents clones or unrelated sessions from forging access', () => {
    const raw = { id: 'document-session', doc: new TestDocument() };
    sessions.push(raw);
    bindWorkflowRoundTripAuthority(raw, authority);
    const spread = { ...raw };
    const clone = structuredClone(raw);

    expect(Object.keys(raw)).toEqual(['id', 'doc']);
    expect(Reflect.ownKeys(raw)).toHaveLength(3);
    expect(workflowRoundTripAuthority(spread)).toBeNull();
    expect(workflowRoundTripAuthority(clone)).toBeNull();
    expect(workflowRoundTripAuthority({ id: raw.id, doc: new TestDocument() })).toBeNull();
    const forged = { id: raw.id, doc: new TestDocument() };
    const capabilityKey = Reflect.ownKeys(raw).find((key): key is symbol => typeof key === 'symbol')!;
    Object.defineProperty(forged, capabilityKey, Object.getOwnPropertyDescriptor(raw, capabilityKey)!);
    expect(workflowRoundTripAuthority(forged)).toBeNull();
    expect(workflowRoundTripSessionsForWorkflow('another-workflow')).toEqual([]);
  });
});
