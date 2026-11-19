import { applyApprovalQuery, assertApprovalPageSize } from './query.js';
import {
  type ApprovalDecisionRecord,
  type ApprovalRequestRecord,
  ApprovalRequestState,
  type ApprovalStore,
  type HumanTaskRecord,
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
    async findRequests(query) {
      return applyApprovalQuery([...requests.values()], query).map((row) => ({ ...row }));
    },
    async listAllRequests({ limit, after }) {
      assertApprovalPageSize(limit, 'limit');
      const ordered = [...requests.values()]
        .filter((row) => after === undefined || row.approvalRequestId > after)
        .sort((a, b) => (a.approvalRequestId < b.approvalRequestId ? -1 : 1));
      const page = ordered.slice(0, limit).map((row) => ({ ...row }));
      const last = page[page.length - 1];
      return ordered.length > limit && last
        ? { requests: page, next: last.approvalRequestId }
        : { requests: page };
    },
    async expireRequests({ approvalRequestIds, now }) {
      const expired: string[] = [];
      const at = new Date(now).getTime();
      for (const id of new Set(approvalRequestIds)) {
        const row = requests.get(id);
        if (!row) continue;
        const live =
          row.state === ApprovalRequestState.Pending || row.state === ApprovalRequestState.Approved;
        if (!live || new Date(row.expiresAt).getTime() > at) continue;
        requests.set(id, {
          ...row,
          state: ApprovalRequestState.Expired,
          updatedAt: now,
          resolvedAt: row.resolvedAt ?? now,
        });
        expired.push(id);
      }
      return expired;
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
    async decideRequest(row, decision) {
      if (requests.get(row.approvalRequestId)?.state !== 'pending') return false;
      requests.set(row.approvalRequestId, { ...row });
      decisions.push({ ...decision });
      return true;
    },
    async transitionRequest(row, fromStates) {
      const stored = requests.get(row.approvalRequestId);
      if (!stored || !fromStates.includes(stored.state)) return false;
      requests.set(row.approvalRequestId, { ...row });
      return true;
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
