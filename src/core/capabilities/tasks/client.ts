/**
 * Checkpoint 20 — RealTasksClient: the googleapis-backed implementation of
 * TasksClient. Direct authorized Tasks API access — never browser
 * automation of tasks.google.com, per §1's explicit instruction.
 *
 * `@default` is Google's own documented special task-list identifier for
 * the user's default list — same role as Calendar's `'primary'` constant,
 * used here as DEFAULT_LIST_ID rather than resolving a real list id first.
 *
 * §8 (Google Tasks API has no search endpoint — verified against the
 * installed typings' Params$Resource$Tasks$List, which only exposes
 * dueMin/dueMax/completedMin/completedMax/showCompleted/showDeleted/
 * showHidden/tasklist/maxResults/pageToken, no query param) — searchTasks()
 * lists tasks across all lists and filters by title client-side, same
 * approach the mock client uses.
 */

import { tasks_v1, google, Auth } from 'googleapis';
import type { TasksClient, TaskItem, TaskList, TaskSearchResult, TaskProposal } from './types';

type OAuth2Client = Auth.OAuth2Client;

export const DEFAULT_LIST_ID = '@default';

function toTaskItem(t: tasks_v1.Schema$Task, taskListId: string): TaskItem {
  return {
    id: t.id!,
    taskListId,
    title: t.title ?? '(untitled)',
    notes: t.notes ?? undefined,
    due: t.due ?? undefined,
    status: t.status === 'completed' ? 'completed' : 'needsAction',
    completed: t.completed ?? undefined,
    position: t.position ?? undefined,
  };
}

function toRequestBody(proposal: TaskProposal): tasks_v1.Schema$Task {
  return {
    title: proposal.title,
    notes: proposal.notes,
    due: proposal.due,
  };
}

export class RealTasksClient implements TasksClient {
  readonly backend = 'real' as const;
  readonly defaultListId = DEFAULT_LIST_ID;
  private tasksApi: tasks_v1.Tasks;

  constructor(auth: OAuth2Client) {
    this.tasksApi = google.tasks({ version: 'v1', auth });
  }

  async listTaskLists(signal?: AbortSignal): Promise<TaskList[]> {
    const resp = await this.tasksApi.tasklists.list({ maxResults: 100 }, { signal });
    return (resp.data.items ?? []).map((l) => ({ id: l.id!, title: l.title ?? '(untitled list)' }));
  }

  async listTasks(taskListId: string, max: number, signal?: AbortSignal): Promise<TaskItem[]> {
    const resp = await this.tasksApi.tasks.list(
      { tasklist: taskListId, maxResults: max, showCompleted: true, showHidden: true },
      { signal }
    );
    return (resp.data.items ?? []).map((t) => toTaskItem(t, taskListId));
  }

  async searchTasks(query: string, max: number, signal?: AbortSignal): Promise<TaskSearchResult> {
    const lists = await this.listTaskLists(signal);
    // AND-of-terms, not one contiguous substring — see mock-client.ts's
    // matching comment for why (mirrors calendar's searchEvents).
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matched: TaskItem[] = [];
    for (const list of lists) {
      if (matched.length >= max) break;
      const tasks = await this.listTasks(list.id, 100, signal);
      matched.push(...tasks.filter((t) => {
        const haystack = t.title.toLowerCase();
        return terms.length > 0 && terms.every((term) => haystack.includes(term));
      }));
    }
    return { query, tasks: matched.slice(0, max) };
  }

  async getTask(taskListId: string, taskId: string, signal?: AbortSignal): Promise<TaskItem | null> {
    try {
      const resp = await this.tasksApi.tasks.get({ tasklist: taskListId, task: taskId }, { signal });
      return toTaskItem(resp.data, taskListId);
    } catch {
      return null;
    }
  }

  async createTask(proposal: TaskProposal, signal?: AbortSignal): Promise<TaskItem> {
    const resp = await this.tasksApi.tasks.insert(
      { tasklist: proposal.taskListId, requestBody: toRequestBody(proposal) },
      { signal }
    );
    return toTaskItem(resp.data, proposal.taskListId);
  }

  async updateTask(proposal: TaskProposal, signal?: AbortSignal): Promise<TaskItem> {
    const resp = await this.tasksApi.tasks.patch(
      { tasklist: proposal.taskListId, task: proposal.existingTaskId!, requestBody: toRequestBody(proposal) },
      { signal }
    );
    return toTaskItem(resp.data, proposal.taskListId);
  }

  async completeTask(taskListId: string, taskId: string, signal?: AbortSignal): Promise<TaskItem> {
    const resp = await this.tasksApi.tasks.patch(
      { tasklist: taskListId, task: taskId, requestBody: { status: 'completed', completed: new Date().toISOString() } },
      { signal }
    );
    return toTaskItem(resp.data, taskListId);
  }

  async deleteTask(taskListId: string, taskId: string, signal?: AbortSignal): Promise<void> {
    await this.tasksApi.tasks.delete({ tasklist: taskListId, task: taskId }, { signal });
  }
}
