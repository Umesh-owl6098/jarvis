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
  selected: 'read' | 'browser';
  reason: string;
  browserFallbackUsed: boolean;
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
}

export type { AgentEvent, OmniRouteHealthStatus };
