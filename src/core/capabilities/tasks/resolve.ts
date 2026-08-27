/**
 * Checkpoint 20 — picks the mock or real Tasks backend, mirroring gmail/
 * calendar/contacts resolve.ts's exact precedent for the same reason:
 * deterministic local testing without live credentials, explicit opt-in,
 * refused in production.
 */

import type { TasksClient } from './types';
import { MockTasksClient } from './mock-client';
import { RealTasksClient } from './client';
import { getAuthorizedTasksClient, isTasksAuthorized } from './auth';

let mockSingleton: MockTasksClient | null = null;

export type TasksAvailability = { available: true } | { available: false; reason: string };

export function tasksAvailability(): TasksAvailability {
  if (useMockTasks()) return { available: true };
  if (!isTasksAuthorized()) {
    return {
      available: false,
      reason: 'Tasks is not connected — visit /api/auth/tasks to grant Tasks access (see TASKS_SETUP.md).',
    };
  }
  return { available: true };
}

function useMockTasks(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return process.env.USE_MOCK_TASKS === 'true';
}

export function getTasksClient(): TasksClient {
  if (useMockTasks()) {
    if (!mockSingleton) mockSingleton = new MockTasksClient();
    return mockSingleton;
  }
  return new RealTasksClient(getAuthorizedTasksClient());
}
