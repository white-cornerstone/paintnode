class WorkflowBoardViewportStore {
  width = $state(1);
  height = $state(1);

  setSize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
  }
}

export const workflowBoardViewport = new WorkflowBoardViewportStore();
