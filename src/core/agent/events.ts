export type AgentEventType =
  | 'task.started'
  | 'task.stopped'
  | 'browser.initialized'
  | 'browser.navigated'
  | 'browser.state.changed'
  | 'agent.observing'
  | 'agent.planning'
  | 'agent.action.started'
  | 'agent.action.completed'
  | 'agent.action.failed'
  | 'agent.recovery'
  | 'router.retry'
  | 'agent.completed'
  | 'agent.failed';

export interface AgentEvent {
  type: AgentEventType;
  timestamp: number;
  taskId?: string;
  stepNumber?: number;
  data?: Record<string, any>;
}

export type EventListener = (event: AgentEvent) => void;

export class EventCollector {
  private events: AgentEvent[] = [];
  private listeners: Set<EventListener> = new Set();
  private taskId: string = '';

  setTaskId(taskId: string): void {
    this.taskId = taskId;
  }

  emit(type: AgentEventType, data?: Record<string, any>, stepNumber?: number): void {
    const event: AgentEvent = {
      type,
      timestamp: Date.now(),
      taskId: this.taskId,
      stepNumber,
      data,
    };
    this.events.push(event);
    for (const listener of this.listeners) {
      try { listener(event); } catch {}
    }
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  getEvents(): AgentEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }
}
