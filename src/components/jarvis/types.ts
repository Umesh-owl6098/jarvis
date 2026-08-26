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
  selected: 'read' | 'browser' | 'gmail' | 'calendar';
  reason: string;
  browserFallbackUsed: boolean;
}

export interface GmailUiState {
  operation: 'list' | 'search' | 'read' | 'summarize' | 'draft' | 'send';
  pendingAction?: { recipient: string[]; subject: string; confirmationRequired: true };
}

export interface CalendarUiState {
  operation: 'list' | 'search' | 'freebusy' | 'propose_create' | 'propose_update' | 'propose_cancel' | 'create' | 'update' | 'delete';
  pendingAction?: { type: 'calendar_create' | 'calendar_update' | 'calendar_delete'; title: string; start: string; confirmationRequired: true };
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
}

export type { AgentEvent, OmniRouteHealthStatus };
