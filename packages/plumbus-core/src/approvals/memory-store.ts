import type {
  ApprovalDecisionRecord,
  ApprovalRequestRecord,
  ApprovalStore,
  HumanTaskRecord,
} from './types.js';

export function createMemoryApprovalStore(): ApprovalStore {
  const requests = new Map<string, ApprovalRequestRecord>();
  const decisions: ApprovalDecisionRecord[] = [];
  const tasks = new Map<string, HumanTaskRecord>();

  return {
    async putRequest(row) {
      requests.set(row.approvalRequestId, { ...row });
    },
    async getRequest(id) {
      const row = requests.get(id);
      return row ? { ...row } : undefined;
    },
    async listRequests() {
      return [...requests.values()].map((row) => ({ ...row }));
    },
    async putDecision(row) {
      decisions.push({ ...row });
    },
    async listDecisions(requestId) {
      return decisions
        .filter((row) => row.approvalRequestId === requestId)
        .map((row) => ({ ...row }));
    },
    async putTask(row) {
      tasks.set(row.humanTaskId, { ...row });
    },
    async getTask(id) {
      const row = tasks.get(id);
      return row ? { ...row } : undefined;
    },
    async listTasksForApprovalRequest(requestId) {
      return [...tasks.values()]
        .filter((row) => row.approvalRequestId === requestId)
        .map((row) => ({ ...row }));
    },
    async cancelRequest(row) {
      if (requests.get(row.approvalRequestId)?.state !== 'pending') return false;
      requests.set(row.approvalRequestId, { ...row });
      for (const [taskId, task] of tasks) {
        if (
          task.approvalRequestId === row.approvalRequestId &&
          (task.state === 'open' || task.state === 'claimed')
        ) {
          tasks.set(taskId, {
            ...task,
            state: 'cancelled',
            updatedAt: row.updatedAt,
            resolvedAt: row.resolvedAt,
          });
        }
      }
      return true;
    },
  };
}
