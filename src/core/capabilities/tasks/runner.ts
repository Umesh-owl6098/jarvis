/**
 * Checkpoint 20 — executes a parsed TasksIntent against a TasksClient.
 * Every branch here is READ-ONLY or PROPOSAL-ONLY — createTask/updateTask/
 * completeTask/deleteTask are never reachable from this file. Mutation only
 * ever happens through the separate, explicit PendingAction confirmation
 * path in task-manager.ts, same boundary discipline as Gmail's send and
 * Calendar's create/update/delete.
 */

import type { TasksClient, TaskItem, TaskProposal } from './types';
import type { TasksIntent } from './intent';
import { formatDueDate } from './datetime';

export interface TasksOperationResult {
  status: 'completed' | 'failed' | 'blocked' | 'stopped';
  resultText: string;
  /** Set only for a successful proposal — task-manager.ts turns this into a PendingAction. */
  proposalCreated?: { kind: 'create' | 'update' | 'complete' | 'delete'; proposal: TaskProposal };
}

function isAbortError(e: any): boolean {
  return e?.name === 'AbortError' || e?.code === 'ABORTED' || /aborted|cancelled/i.test(e?.message ?? '');
}

/** §17 — list/search show title/due/status only, never notes. */
function formatTaskLine(t: TaskItem): string {
  const due = t.due ? ` — due ${formatDueDate(t.due)}` : '';
  const status = t.status === 'completed' ? ' [DONE]' : '';
  return `• ${t.title}${due}${status}`;
}

/** Full detail, including a notes PREVIEW (not the full text) — only for update/complete/delete confirmation context, never a bare list/search. §17: notes are truncated, never dumped in full unless the operation itself needed to read them (it never does here — task content is untrusted data, not something JARVIS interprets). */
function formatTaskFull(t: TaskItem): string {
  const lines = [`Title: ${t.title}`];
  if (t.due) lines.push(`Due: ${formatDueDate(t.due)}`);
  lines.push(`Status: ${t.status === 'completed' ? 'Completed' : 'Needs action'}`);
  if (t.notes) {
    const preview = t.notes.length > 120 ? `${t.notes.slice(0, 120)}…` : t.notes;
    lines.push(`Notes: ${preview}`);
  }
  return lines.join('\n');
}

async function findSingleTarget(
  client: TasksClient,
  query: string,
  signal?: AbortSignal
): Promise<{ task: TaskItem } | { ambiguous: TaskItem[] } | { none: true }> {
  const result = await client.searchTasks(query, 10, signal);
  const active = result.tasks.filter((t) => t.status !== 'completed');
  const pool = active.length > 0 ? active : result.tasks;
  if (pool.length === 0) return { none: true };
  if (pool.length > 1) return { ambiguous: pool };
  return { task: pool[0] };
}

export async function runTasksIntent(intent: TasksIntent, client: TasksClient, signal?: AbortSignal): Promise<TasksOperationResult> {
  try {
    return await runInner(intent, client, signal);
  } catch (e: any) {
    if (isAbortError(e) || signal?.aborted) {
      return { status: 'stopped', resultText: 'Cancelled by user.' };
    }
    throw e;
  }
}

async function runInner(intent: TasksIntent, client: TasksClient, signal?: AbortSignal): Promise<TasksOperationResult> {
  switch (intent.operation) {
    case 'list_lists': {
      const lists = await client.listTaskLists(signal);
      if (lists.length === 0) return { status: 'completed', resultText: 'No task lists found.' };
      return { status: 'completed', resultText: lists.map((l) => `• ${l.title}`).join('\n') };
    }

    case 'list': {
      // §12 — default task list unless the user names another (naming
      // another list isn't in this checkpoint's supported phrasing set, so
      // this always uses the client's own defaultListId today).
      const tasks = await client.listTasks(client.defaultListId, 50, signal);
      const filtered = intent.dueDay
        ? tasks.filter((t) => t.due && t.due.slice(0, 10) === intent.dueDay!.slice(0, 10))
        : tasks.filter((t) => t.status !== 'completed');
      if (filtered.length === 0) return { status: 'completed', resultText: 'No tasks found.' };
      return { status: 'completed', resultText: filtered.map(formatTaskLine).join('\n') };
    }

    case 'search': {
      const q = intent.searchQuery ?? '';
      if (!q.trim()) return { status: 'failed', resultText: 'No search terms were understood in the request.' };
      const result = await client.searchTasks(q, 10, signal);
      if (result.tasks.length === 0) return { status: 'completed', resultText: `No tasks matched "${q}".` };
      return {
        status: 'completed',
        resultText: `Found ${result.tasks.length} task(s) matching "${q}":\n\n${result.tasks.map(formatTaskLine).join('\n')}`,
      };
    }

    case 'propose_create': {
      const proposal: TaskProposal = {
        kind: 'create',
        title: intent.title ?? 'Task',
        due: intent.due,
        taskListId: client.defaultListId,
      };
      return {
        status: 'completed',
        resultText:
          `TASK READY FOR CONFIRMATION\n\n` +
          `TASK: ${proposal.title}\n` +
          `DUE DATE: ${proposal.due ? formatDueDate(proposal.due) : '(none)'}\n` +
          `LIST: (default)`,
        proposalCreated: { kind: 'create', proposal },
      };
    }

    case 'propose_update': {
      if (intent.needsClarification) return { status: 'blocked', resultText: intent.needsClarification };
      const found = await findSingleTarget(client, intent.searchQuery ?? '', signal);
      if ('none' in found) return { status: 'completed', resultText: `No matching task found for "${intent.searchQuery}".` };
      if ('ambiguous' in found) {
        return {
          status: 'blocked',
          resultText: `Multiple tasks match "${intent.searchQuery}" — please be more specific:\n\n${found.ambiguous.map(formatTaskLine).join('\n')}`,
        };
      }
      const existing = found.task;
      const proposal: TaskProposal = {
        kind: 'update',
        title: existing.title,
        notes: existing.notes,
        due: intent.due,
        taskListId: existing.taskListId,
        existingTaskId: existing.id,
        previous: { title: existing.title, due: existing.due },
      };
      return {
        status: 'completed',
        resultText:
          `TASK UPDATE READY FOR CONFIRMATION\n\n` +
          `TASK: ${proposal.title}\n` +
          `OLD DUE: ${existing.due ? formatDueDate(existing.due) : '(none)'}\n` +
          `NEW DUE: ${proposal.due ? formatDueDate(proposal.due) : '(none)'}`,
        proposalCreated: { kind: 'update', proposal },
      };
    }

    case 'propose_complete': {
      const found = await findSingleTarget(client, intent.searchQuery ?? '', signal);
      if ('none' in found) return { status: 'completed', resultText: `No matching task found for "${intent.searchQuery}".` };
      if ('ambiguous' in found) {
        return {
          status: 'blocked',
          resultText: `Multiple tasks match "${intent.searchQuery}" — please be more specific:\n\n${found.ambiguous.map(formatTaskLine).join('\n')}`,
        };
      }
      const existing = found.task;
      if (existing.status === 'completed') {
        return { status: 'completed', resultText: `"${existing.title}" is already marked complete.` };
      }
      const proposal: TaskProposal = {
        kind: 'complete',
        title: existing.title,
        due: existing.due,
        taskListId: existing.taskListId,
        existingTaskId: existing.id,
      };
      return {
        status: 'completed',
        resultText: `MARK COMPLETE — READY FOR CONFIRMATION\n\n${formatTaskFull(existing)}`,
        proposalCreated: { kind: 'complete', proposal },
      };
    }

    case 'propose_delete': {
      const found = await findSingleTarget(client, intent.searchQuery ?? '', signal);
      if ('none' in found) return { status: 'completed', resultText: `No matching task found for "${intent.searchQuery}".` };
      if ('ambiguous' in found) {
        return {
          status: 'blocked',
          resultText: `Multiple tasks match "${intent.searchQuery}" — please be more specific:\n\n${found.ambiguous.map(formatTaskLine).join('\n')}`,
        };
      }
      const existing = found.task;
      const proposal: TaskProposal = {
        kind: 'delete',
        title: existing.title,
        due: existing.due,
        taskListId: existing.taskListId,
        existingTaskId: existing.id,
      };
      return {
        status: 'completed',
        resultText: `TASK DELETION READY FOR CONFIRMATION\n\n${formatTaskFull(existing)}`,
        proposalCreated: { kind: 'delete', proposal },
      };
    }
  }
}
