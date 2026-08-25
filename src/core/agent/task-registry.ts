/**
 * TaskRegistry: Minimal task tracker for cancellation.
 * Tracks active tasks so they can be located and cancelled safely.
 */

interface TaskEntry {
  taskId: string;
  abortController: AbortController;
  status: 'running' | 'stopped' | 'completed' | 'failed';
  startedAt: number;
  stoppedAt?: number;
}

export class TaskRegistry {
  private tasks: Map<string, TaskEntry> = new Map();

  registerTask(taskId: string, abortController: AbortController): void {
    console.log(`[TaskRegistry] Registering task: ${taskId}`);
    this.tasks.set(taskId, {
      taskId,
      abortController,
      status: 'running',
      startedAt: Date.now(),
    });
    console.log(`[TaskRegistry] Total tasks: ${this.tasks.size}`);
  }

  stopTask(taskId: string): boolean {
    console.log(`[TaskRegistry] Stop requested for: ${taskId}`);
    const task = this.tasks.get(taskId);
    if (!task) {
      console.log(`[TaskRegistry] Task not found: ${taskId}, registered tasks: ${Array.from(this.tasks.keys()).join(', ')}`);
      return false;
    }

    if (task.status !== 'running') {
      console.log(`[TaskRegistry] Task is not running, status: ${task.status}`);
      return false;
    }

    console.log(`[TaskRegistry] Stopping task: ${taskId}`);
    task.status = 'stopped';
    task.stoppedAt = Date.now();
    task.abortController.abort();
    console.log(`[TaskRegistry] Task aborted successfully`);
    return true;
  }

  completeTask(taskId: string, status: 'completed' | 'failed' | 'stopped'): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = status;
    task.stoppedAt = Date.now();
  }

  getTask(taskId: string): TaskEntry | undefined {
    return this.tasks.get(taskId);
  }

  getStatus(taskId: string): TaskEntry['status'] | 'not_found' {
    const task = this.tasks.get(taskId);
    return task?.status ?? 'not_found';
  }

  cleanupCompleted(): void {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes

    for (const [id, task] of this.tasks.entries()) {
      if (task.status !== 'running' && now - (task.stoppedAt ?? task.startedAt) > maxAge) {
        this.tasks.delete(id);
      }
    }
  }
}

export const taskRegistry = new TaskRegistry();
