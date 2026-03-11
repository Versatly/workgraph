import { dispatch as dispatchModule } from '@versatly/workgraph-kernel';

export const {
  createRun,
  claimThread,
  status,
  followup,
  stop,
  markRun,
  heartbeat,
  reconcileExpiredLeases,
  reconcileExternalRun,
  pollExternalRuns,
  handoffRun,
  logs,
  listRuns,
  executeRun,
  createAndExecuteRun,
} = dispatchModule;

export type DispatchCreateInput = Parameters<typeof createRun>[1];
export type DispatchClaimResult = ReturnType<typeof claimThread>;
export type DispatchExecuteInput = Parameters<typeof executeRun>[2];
export type DispatchHeartbeatInput = Parameters<typeof heartbeat>[2];
export type DispatchReconcileResult = ReturnType<typeof reconcileExpiredLeases>;
export type DispatchExternalReconcileInput = Parameters<typeof reconcileExternalRun>[1];
export type DispatchHandoffInput = Parameters<typeof handoffRun>[2];
export type DispatchHandoffResult = ReturnType<typeof handoffRun>;
