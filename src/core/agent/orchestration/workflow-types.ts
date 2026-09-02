/**
 * Checkpoint 26 (narrow extraction) — the result/status shapes shared by
 * every deterministic orchestration pattern and by orchestrator.ts's own
 * public entry point. Pulled into its own file solely so both
 * workflow-patterns.ts (which builds these) and orchestrator.ts (which
 * re-exports them as part of its existing public API) can import the same
 * definitions without a circular import between the two.
 */

export type OrchestrationStepStatus = 'completed' | 'pending_confirmation' | 'failed' | 'skipped_dependency';

export interface OrchestrationStepResult {
  id: string;
  capability: 'calendar' | 'gmail' | 'tasks';
  description: string;
  status: OrchestrationStepStatus;
  resultText: string;
  /**
   * Checkpoint 21 fix — true ONLY when this step performed a real,
   * externally-visible backend WRITE that is not itself gated behind a
   * confirmation (Gmail draft creation is the one case among the 4
   * patterns: draft creation has never been confirmation-gated, per
   * Checkpoint 17's own established semantics — only SEND is). Calendar's
   * and Tasks' propose_* operations never call createEvent/createTask, so
   * this is always false for them; they're pure in-memory PendingAction
   * proposals until separately confirmed. Reporting code must check this
   * explicitly rather than inferring "no mutation" from `status !==
   * 'completed'` — a 'pending_confirmation' Gmail-draft step still
   * performed a real write.
   */
  remoteWriteOccurred?: boolean;
}

export interface OrchestrationResult {
  /** Which fixed pattern matched — for observability only. */
  pattern: string;
  status: 'completed' | 'partial' | 'blocked' | 'failed';
  steps: OrchestrationStepResult[];
  summaryText: string;
}
