'use client';

import type { TaskUiState } from './types';

interface DeveloperInspectorProps {
  task: TaskUiState | null;
  /** Active planner backend, e.g. "OMNIROUTE" or "SLOW MOCK". */
  routerLabel?: string;
}

function Row({ label, value }: { label: string; value: string | number | undefined | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]">
      <span className="j-label shrink-0">{label}</span>
      <span
        className="j-num min-w-0 truncate text-right text-[10.5px] text-[color:var(--j-body)]"
        title={value != null ? String(value) : undefined}
      >
        {value ?? '—'}
      </span>
    </div>
  );
}

export function DeveloperInspector({ task, routerLabel }: DeveloperInspectorProps) {
  if (!task) {
    return <p className="j-label py-1">No active task</p>;
  }

  const countOf = (type: string) => task.events.filter((e) => e.type === type).length;

  return (
    <div className="divide-y" style={{ borderColor: 'rgba(53,224,255,0.1)' }}>
      <Row label="Task ID" value={task.taskId || '—'} />
      <Row label="Status" value={task.status} />
      <Row label="Goal" value={task.goal} />
      {task.goalAnalysis && (
        <Row
          label="Goal type"
          value={task.goalAnalysis.compound ? `COMPOUND · ${task.goalAnalysis.objectiveCount} objectives` : 'SIMPLE'}
        />
      )}
      {task.plannerCalls != null && <Row label="Planner calls" value={task.plannerCalls} />}
      {task.plan?.repairCalls != null && task.plan.repairCalls > 0 && (
        <Row label="Repair calls" value={task.plan.repairCalls} />
      )}
      {task.capability && (
        <Row
          label="Capability"
          value={
            task.capability.selected === 'gmail'
              ? 'GMAIL'
              : task.capability.selected === 'calendar'
                ? 'CALENDAR'
                : task.capability.selected === 'tasks'
                  ? 'TASKS'
                  : task.capability.selected === 'read'
                    ? 'READ'
                    : task.capability.browserFallbackUsed
                      ? 'BROWSER (read fallback)'
                      : 'BROWSER'
          }
        />
      )}
      {task.gmail && <Row label="Operation" value={task.gmail.operation.toUpperCase()} />}
      {task.gmail?.pendingAction && (
        <>
          <Row label="Pending action" value={`SEND EMAIL · ${task.gmail.pendingAction.recipient.join(', ')}`} />
          <Row label="Confirmation" value="REQUIRED" />
        </>
      )}
      {task.calendar && <Row label="Operation" value={task.calendar.operation.toUpperCase()} />}
      {task.calendar?.pendingAction && (
        <>
          <Row
            label="Pending action"
            value={`${task.calendar.pendingAction.type.replace('calendar_', '').toUpperCase()} EVENT · ${task.calendar.pendingAction.title}`}
          />
          <Row label="Confirmation" value="REQUIRED" />
        </>
      )}
      {task.tasks && <Row label="Operation" value={task.tasks.operation.toUpperCase()} />}
      {task.tasks?.pendingAction && (
        <>
          <Row
            label="Pending action"
            value={`${task.tasks.pendingAction.type.replace('tasks_', '').toUpperCase()} TASK · ${task.tasks.pendingAction.title}`}
          />
          <Row label="Confirmation" value="REQUIRED" />
        </>
      )}
      {task.resolution && (
        <Row
          label="Resolution"
          value={
            task.resolution.status === 'resolved'
              ? `${task.resolution.query} → ${task.resolution.email}`
              : task.resolution.status === 'ambiguous'
                ? `AMBIGUOUS · ${task.resolution.query}`
                : task.resolution.status === 'ambiguous_email'
                  ? `MULTIPLE EMAILS · ${task.resolution.query}`
                  : `NOT FOUND · ${task.resolution.query}`
          }
        />
      )}
      <Row label="Events" value={task.events.length} />
      <Row label="Observe" value={countOf('agent.observing')} />
      <Row label="Plan" value={countOf('agent.planning')} />
      <Row label="Act" value={countOf('agent.action.started')} />
      <Row label="Act failed" value={countOf('agent.action.failed')} />
      <Row label="Router retry" value={countOf('router.retry')} />
      <Row label="Recovery" value={countOf('agent.recovery')} />
      <Row label="Browser URL" value={task.browser.url || '—'} />
      <Row
        label="Duration"
        value={task.metrics.durationMs != null ? `${(task.metrics.durationMs / 1000).toFixed(1)}s` : '—'}
      />
      {task.plan && (
        <div className="py-[3px]">
          <div className="j-label mb-1 flex items-baseline justify-between">
            <span>Plan</span>
            <span>
              {task.plan.subgoals.length} subgoal{task.plan.subgoals.length === 1 ? '' : 's'}
              {task.plan.replans > 0 ? ` · ${task.plan.replans} replan${task.plan.replans === 1 ? '' : 's'}` : ''}
            </span>
          </div>
          <div className="space-y-[2px]">
            {task.plan.subgoals.map((sg) => {
              const mark =
                sg.status === 'completed' ? '✓' : sg.status === 'active' ? '●' : sg.status === 'blocked' ? '⚠' : sg.status === 'failed' ? '✕' : '○';
              return (
                <div key={sg.id} className="truncate text-[10.5px] text-[color:var(--j-body)]" title={sg.description}>
                  {mark} {sg.id} {sg.description}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
