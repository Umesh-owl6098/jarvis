import type { AgentEvent } from '@/core/agent/events';
import type { ExecutionResult } from '@/core/agent/executor';

export interface StreamEvent {
  type: 'event' | 'result' | 'error';
  event?: AgentEvent;
  result?: ExecutionResult;
  error?: string;
}

export type StreamCallback = (event: StreamEvent) => void;

export async function streamAgentTask(
  goal: string,
  onEvent: StreamCallback,
  signal?: AbortSignal,
  sessionId?: string
): Promise<ExecutionResult | undefined> {
  const response = await fetch('/api/agent/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Checkpoint 22 fix — the same opaque per-tab session id every command
      // from this UI session carries, typed or voice alike (see page.tsx).
      // Omitted only if the caller genuinely has none yet; the server treats
      // a missing/invalid header as its own isolated one-off session rather
      // than any shared default.
      ...(sessionId ? { 'X-Jarvis-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify({ goal }),
    signal,
  });

  if (!response.ok) {
    const error = await response.text();
    onEvent({ type: 'error', error: `HTTP ${response.status}: ${error}` });
    return undefined;
  }

  if (!response.body) {
    onEvent({ type: 'error', error: 'No response body' });
    return undefined;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: ExecutionResult | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse complete SSE frames (delimited by double newline)
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || ''; // Keep incomplete frame in buffer

      for (const frame of frames) {
        if (!frame.trim()) continue;

        const lines = frame.split('\n');
        let eventType = '';
        let eventData = '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice('event: '.length);
          } else if (line.startsWith('data: ')) {
            eventData = line.slice('data: '.length);
          }
        }

        if (!eventType || !eventData) continue;

        try {
          if (eventType === 'task.result') {
            result = JSON.parse(eventData);
            onEvent({ type: 'result', result });
          } else if (eventType === 'task.error') {
            const err = JSON.parse(eventData);
            onEvent({ type: 'error', error: err.error });
          } else if (eventType === 'task.stopped') {
            // The stop frame carries { taskId, reason, timestamp } with no `type`
            // field, so normalise it into a real AgentEvent for consumers.
            const payload = JSON.parse(eventData);
            onEvent({
              type: 'event',
              event: {
                type: 'task.stopped',
                timestamp: payload.timestamp ?? Date.now(),
                taskId: payload.taskId,
                data: { reason: payload.reason },
              },
            });
          } else {
            // Real backend event
            const event: AgentEvent = JSON.parse(eventData);
            onEvent({ type: 'event', event });
          }
        } catch (e) {
          console.error(`Failed to parse SSE event: ${eventType}`, e);
        }
      }
    }

    // Handle final incomplete frame
    if (buffer.trim()) {
      const lines = buffer.split('\n');
      let eventType = '';
      let eventData = '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice('event: '.length);
        } else if (line.startsWith('data: ')) {
          eventData = line.slice('data: '.length);
        }
      }

      if (eventType && eventData) {
        try {
          if (eventType === 'task.result') {
            result = JSON.parse(eventData);
            onEvent({ type: 'result', result });
          } else if (eventType === 'task.error') {
            const err = JSON.parse(eventData);
            onEvent({ type: 'error', error: err.error });
          } else if (eventType === 'task.stopped') {
            const payload = JSON.parse(eventData);
            onEvent({
              type: 'event',
              event: {
                type: 'task.stopped',
                timestamp: payload.timestamp ?? Date.now(),
                taskId: payload.taskId,
                data: { reason: payload.reason },
              },
            });
          }
        } catch (e) {
          console.error(`Failed to parse final SSE event: ${eventType}`, e);
        }
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name !== 'AbortError') {
      onEvent({ type: 'error', error: error.message });
    }
  } finally {
    reader.releaseLock();
  }

  return result;
}
