/**
 * Checkpoint 20 §6 — normalized Tasks types. Google Tasks API objects never
 * leak past this boundary — same discipline as Gmail's MailMessage/
 * MailThread and Calendar's CalendarEvent. Only the fields JARVIS actually
 * uses are kept; Google Tasks API objects carry several read-only/output-only
 * fields (kind, etag, selfLink, webViewLink, links, hidden, assignmentInfo)
 * that are never surfaced here.
 */

export interface TaskItem {
  id: string;
  taskListId: string;
  title: string;
  notes?: string;
  /** RFC 3339 timestamp — §29: Google Tasks' `due` is DATE-ONLY. The time-of-day portion is discarded by the API itself; never treat this as a scheduled time or alarm. */
  due?: string;
  status: 'needsAction' | 'completed';
  /** RFC 3339 timestamp — only set when status === 'completed'. */
  completed?: string;
  position?: string;
}

export interface TaskList {
  id: string;
  title: string;
}

export interface TaskSearchResult {
  query: string;
  tasks: TaskItem[];
}

/**
 * §8 — a proposal is NEVER itself a committed mutation; it's the "here's
 * what I'm about to do" structure shown to the user before any
 * create/update/complete/delete call is made. TaskManager turns an accepted
 * proposal into a PendingAction (tasks/pending-action.ts), never the other
 * way around.
 */
export interface TaskProposal {
  kind: 'create' | 'update' | 'complete' | 'delete';
  title: string;
  notes?: string;
  due?: string;
  taskListId: string;
  /** Set for update/complete/delete — the task being changed. */
  existingTaskId?: string;
  /** Set for update — the task's state before the proposed change. */
  previous?: { title: string; due?: string };
}

/**
 * §4 — the controlled Tasks capability boundary. Both the real
 * (googleapis-backed) and mock implementations satisfy this exact contract.
 * No bulk operations, no task-list create/delete — task-list SELECTION only
 * (§12), and task CRUD within a list.
 */
export interface TasksClient {
  readonly backend: 'real' | 'mock';
  /** §12 — the id to use when the user doesn't explicitly name a task list. Real: Google's own `@default` alias. Mock: the fixture's primary list id — deliberately NOT inferred from list ORDER, since tasklists.list's ordering isn't a documented guarantee. */
  readonly defaultListId: string;
  listTaskLists(signal?: AbortSignal): Promise<TaskList[]>;
  listTasks(taskListId: string, max: number, signal?: AbortSignal): Promise<TaskItem[]>;
  searchTasks(query: string, max: number, signal?: AbortSignal): Promise<TaskSearchResult>;
  getTask(taskListId: string, taskId: string, signal?: AbortSignal): Promise<TaskItem | null>;
  createTask(proposal: TaskProposal, signal?: AbortSignal): Promise<TaskItem>;
  updateTask(proposal: TaskProposal, signal?: AbortSignal): Promise<TaskItem>;
  completeTask(taskListId: string, taskId: string, signal?: AbortSignal): Promise<TaskItem>;
  deleteTask(taskListId: string, taskId: string, signal?: AbortSignal): Promise<void>;
}
