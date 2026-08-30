import type { AgentEvent } from '@/core/agent/events';
import type { OmniRouteHealthStatus } from '@/core/router/client';

export type TaskUiStatus = 'idle' | 'running' | 'stopping' | 'completed' | 'failed' | 'stopped';

export interface TaskMetrics {
  durationMs: number | null;
  steps: number;
  tokens: number;
  model?: string;
  provider?: string;
}

export interface BrowserUiState {
  url: string;
  title: string;
  status: 'idle' | 'loading' | 'ready';
}

export interface CapabilityUiState {
  selected: 'read' | 'browser' | 'gmail' | 'calendar' | 'tasks' | 'orchestration';
  reason: string;
  browserFallbackUsed: boolean;
}

export interface OrchestrationUiState {
  pattern: string;
  status: 'completed' | 'partial' | 'blocked' | 'failed';
  steps: { id: string; capability: 'calendar' | 'gmail' | 'tasks'; description: string; status: 'completed' | 'pending_confirmation' | 'failed' | 'skipped_dependency'; resultText: string; remoteWriteOccurred?: boolean }[];
}

export interface GmailUiState {
  operation: 'list' | 'search' | 'read' | 'summarize' | 'draft' | 'send';
  pendingAction?: { recipient: string[]; subject: string; confirmationRequired: true };
}

export interface CalendarUiState {
  operation: 'list' | 'search' | 'freebusy' | 'propose_create' | 'propose_update' | 'propose_cancel' | 'create' | 'update' | 'delete';
  pendingAction?: { type: 'calendar_create' | 'calendar_update' | 'calendar_delete'; title: string; start: string; confirmationRequired: true };
}

export interface TasksUiState {
  operation: 'list_lists' | 'list' | 'search' | 'propose_create' | 'propose_update' | 'propose_complete' | 'propose_delete' | 'create' | 'update' | 'complete' | 'delete';
  pendingAction?: { type: 'tasks_create' | 'tasks_update' | 'tasks_complete' | 'tasks_delete'; title: string; due?: string; confirmationRequired: true };
}

export interface ResolutionUiState {
  query: string;
  status: 'resolved' | 'ambiguous' | 'ambiguous_email' | 'not_found';
  email?: string;
}

export interface PlanSubgoalUiState {
  id: string;
  description: string;
  type: string;
  status: string;
}

export interface PlanUiState {
  subgoals: PlanSubgoalUiState[];
  replans: number;
  repairCalls?: number;
}

export interface GoalAnalysisUiState {
  compound: boolean;
  objectiveCount: number;
}

export interface TaskUiState {
  taskId: string;
  goal: string;
  status: TaskUiStatus;
  events: AgentEvent[];
  result: string;
  metrics: TaskMetrics;
  browser: BrowserUiState;
  capability?: CapabilityUiState;
  plan?: PlanUiState;
  goalAnalysis?: GoalAnalysisUiState;
  plannerCalls?: number;
  gmail?: GmailUiState;
  calendar?: CalendarUiState;
  tasks?: TasksUiState;
  resolution?: ResolutionUiState;
  orchestration?: OrchestrationUiState;
}

export type { AgentEvent, OmniRouteHealthStatus };
