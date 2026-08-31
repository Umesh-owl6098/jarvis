/**
 * Checkpoint 23 — turns a parsed PreferenceCommand into an ExecutionResult,
 * the same shape every other capability path already returns. Preference
 * writes/reads/deletes are pure local file I/O — no network call, no
 * confirmation gate (there is nothing to confirm: this is configuration,
 * not a Gmail/Calendar/Tasks mutation), and no capability runner is ever
 * touched from here.
 */

import type { EventListener } from '@/core/agent/events';
import type { ExecutionResult } from '@/core/agent/executor';
import { preferencesStore } from './store';
import { FIELD_LABEL, type PreferenceField, type UserPreferences } from './types';
import type { PreferenceCommand } from './intent';

function snapshotOf(prefs: UserPreferences) {
  return {
    meetingDurationMinutes: prefs.meetingDurationMinutes,
    emailStyle: prefs.emailStyle,
    defaultMeetingLocation: prefs.defaultMeetingLocation,
  };
}

function formatValue(field: PreferenceField, prefs: UserPreferences): string {
  if (field === 'meetingDurationMinutes') {
    return prefs.meetingDurationMinutes !== undefined ? `${prefs.meetingDurationMinutes} minutes` : '(not set)';
  }
  if (field === 'emailStyle') {
    return prefs.emailStyle ?? '(not set)';
  }
  return prefs.defaultMeetingLocation === 'google_meet' ? 'Google Meet' : prefs.defaultMeetingLocation === 'none' ? 'none' : '(not set)';
}

function describeAll(prefs: UserPreferences): string {
  const lines = (['meetingDurationMinutes', 'emailStyle', 'defaultMeetingLocation'] as const).map(
    (f) => `${FIELD_LABEL[f]}: ${formatValue(f, prefs)}`
  );
  if (Object.keys(prefs).length === 0) return "You haven't told me any preferences yet.";
  return `Here's what I remember:\n${lines.join('\n')}`;
}

function baseResult(taskId: string, goal: string, resultText: string, extra: PreferenceCommand): ExecutionResult {
  const prefs = preferencesStore.getAll();
  return {
    taskId,
    goal,
    status: 'success',
    outcome: 'completed',
    result: resultText,
    steps: 0,
    tokensUsed: 0,
    actions: [`preferences:${extra.kind}${extra.field !== 'all' ? ` (${extra.field})` : ''}`],
    events: [],
    capability: { selected: 'preferences', reason: 'Explicit preference command.', readAttempted: false, browserFallbackUsed: false },
    preferences: { operation: extra.kind, field: extra.field, snapshot: snapshotOf(prefs) },
  };
}

export function attemptPreferenceCommand(
  rawGoal: string,
  taskId: string,
  onEvent: EventListener,
  command: PreferenceCommand
): ExecutionResult {
  onEvent({ type: 'task.started', timestamp: Date.now(), taskId, data: { task: rawGoal, capability: 'preferences' as any } });

  let resultText: string;

  if (command.kind === 'set') {
    const prefs = preferencesStore.set(command.field, command.value as never);
    resultText = `Got it — I'll remember your ${FIELD_LABEL[command.field]}: ${formatValue(command.field, prefs)}.`;
  } else if (command.kind === 'get') {
    const prefs = preferencesStore.getAll();
    resultText = command.field === 'all' ? describeAll(prefs) : `Your ${FIELD_LABEL[command.field]}: ${formatValue(command.field, prefs)}.`;
  } else {
    if (command.field === 'all') {
      preferencesStore.forgetAll();
      resultText = 'Cleared all your stored preferences.';
    } else {
      preferencesStore.forget(command.field);
      resultText = `Forgot your ${FIELD_LABEL[command.field]} preference.`;
    }
  }

  onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'preferences' as any } });
  return baseResult(taskId, rawGoal, resultText, command);
}
