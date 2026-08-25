'use client';

import { useEffect, useRef } from 'react';
import type { AgentEvent } from './types';

interface ActivityTimelineProps {
  events: AgentEvent[];
  isRunning: boolean;
  showDevDetails: boolean;
  /**
   * Render only the most recent N events. History is never discarded — the
   * full array still lives on the task and is shown in Diagnostics.
   */
  maxVisible?: number;
}

const EVENT_LABELS: Record<string, string> = {
  'task.started': 'Task started',
  'task.stopped': 'Task stopped',
  'browser.initialized': 'Browser initialized',
  'browser.navigated': 'Browser navigated',
  'browser.state.changed': 'Page state captured',
  'agent.observing': 'Observing page',
  'agent.planning': 'Planning next action',
  'agent.action.started': 'Executing action',
  'agent.action.completed': 'Action completed',
  'agent.action.failed': 'Action failed',
  'agent.recovery': 'Recovery attempt',
  'router.retry': 'Router retry',
  'agent.completed': 'Task completed',
  'agent.failed': 'Task failed',
};

type Status = 'success' | 'failed' | 'running' | 'pending';

function eventStatus(type: string): Status {
  if (type === 'agent.completed' || type === 'agent.action.completed' || type === 'browser.initialized')
    return 'success';
  if (type === 'agent.failed' || type === 'agent.action.failed') return 'failed';
  if (type === 'agent.observing' || type === 'agent.planning' || type === 'agent.action.started')
    return 'running';
  return 'pending';
}

const STATUS_COLOR: Record<Status, string> = {
  success: 'var(--j-ok)',
  failed: 'var(--j-bad)',
  running: 'var(--j-accent)',
  pending: 'var(--j-dormant)',
};

const STATUS_GLYPH: Record<Status, string> = {
  success: '✓',
  failed: '✕',
  running: '▸',
  pending: '·',
};

function eventDetail(event: AgentEvent): string | null {
  if (event.type === 'agent.action.started' && event.data?.skillId) return event.data.skillId;
  if (event.type === 'agent.action.started' && event.data?.action) return event.data.action;
  if (event.type === 'agent.planning' && event.data?.url) return event.data.url;
  if (event.type === 'browser.state.changed' && event.data?.url) return event.data.url;
  if (event.type === 'agent.action.failed' && event.data?.error) return event.data.error;
  if (event.type === 'agent.failed' && event.data?.reason) return event.data.reason;
  if (event.type === 'agent.completed' && event.data?.result) {
    const r = String(event.data.result);
    return r.length > 90 ? r.slice(0, 90) + '…' : r;
  }
  return null;
}

function elapsedFrom(first: AgentEvent | undefined, event: AgentEvent): string {
  if (!first) return '00.0';
  return ((event.timestamp - first.timestamp) / 1000).toFixed(1).padStart(4, '0');
}

export function ActivityTimeline({
  events,
  isRunning,
  showDevDetails,
  maxVisible = 40,
}: ActivityTimelineProps) {
  const endRef = useRef<HTMLDivElement>(null);

  // follow the trace as real events arrive
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [events.length]);

  const hidden = Math.max(0, events.length - maxVisible);
  const visible = hidden > 0 ? events.slice(-maxVisible) : events;

  if (events.length === 0) {
    return (
      <p className="j-label py-1" aria-live="polite">
        {isRunning ? 'Awaiting telemetry…' : 'No execution trace'}
      </p>
    );
  }

  return (
    <ol className="relative space-y-[3px]" aria-live="polite">
      {/* trace spine */}
      <span
        aria-hidden="true"
        className="absolute bottom-1 left-[41px] top-1 w-px"
        style={{ background: 'linear-gradient(180deg, var(--j-accent-line), transparent)' }}
      />

      {hidden > 0 && (
        <li className="pb-1 pl-[38px]">
          <span className="j-label" style={{ letterSpacing: '0.1em' }}>
            ↑ {hidden} earlier event{hidden === 1 ? '' : 's'} · full history in Diagnostics
          </span>
        </li>
      )}

      {visible.map((event, idx) => {
        const status = eventStatus(event.type);
        const color = STATUS_COLOR[status];
        const label = EVENT_LABELS[event.type] || event.type;
        const detail = eventDetail(event);
        const live = isRunning && idx === visible.length - 1;

        return (
          <li key={`${event.timestamp}-${idx}`} className="flex items-start gap-2">
            <span className="j-num w-[30px] shrink-0 pt-[3px] text-[9.5px] leading-none text-[color:var(--j-mute)]">
              {elapsedFrom(events[0], event)}
            </span>

            <span
              className={`relative z-10 mt-[1px] flex h-[13px] w-[13px] shrink-0 items-center justify-center text-[8px] leading-none ${
                live ? 'j-blink' : ''
              }`}
              style={{
                color,
                border: `1px solid ${color}55`,
                background: 'var(--j-void)',
                boxShadow: live ? `0 0 8px ${color}` : 'none',
              }}
              aria-hidden="true"
            >
              {STATUS_GLYPH[status]}
            </span>

            <div className="min-w-0 flex-1 pb-[2px]">
              <p
                className="truncate text-[11.5px] leading-[1.35]"
                style={{ color: status === 'pending' ? 'var(--j-body)' : color }}
              >
                {label}
                {event.stepNumber != null && (
                  <span className="j-num ml-1.5 text-[9.5px] text-[color:var(--j-mute)]">
                    S{event.stepNumber}
                  </span>
                )}
              </p>
              {detail && (
                <p className="j-num truncate text-[10px] leading-[1.4] text-[color:var(--j-mute)]" title={detail}>
                  {detail}
                </p>
              )}
              {showDevDetails && (
                <p className="j-num text-[9px] text-[color:var(--j-mute)] opacity-70">
                  {event.type} · {new Date(event.timestamp).toLocaleTimeString()}
                </p>
              )}
            </div>
          </li>
        );
      })}
      <div ref={endRef} />
    </ol>
  );
}
