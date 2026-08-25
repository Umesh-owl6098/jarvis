'use client';

import type { TaskMetrics } from './types';
import { Stat } from './hud/HudKit';

interface MetricsBarProps {
  metrics: TaskMetrics;
  /** Live elapsed override while a task is still running. */
  liveMs?: number | null;
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  return (ms / 1000).toFixed(1);
}

export function MetricsBar({ metrics, liveMs }: MetricsBarProps) {
  const duration = liveMs ?? metrics.durationMs;

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Elapsed" value={formatDuration(duration)} unit="s" />
        <Stat label="Steps" value={metrics.steps} />
        <Stat label="Tokens" value={metrics.tokens > 0 ? metrics.tokens.toLocaleString() : '—'} />
      </div>

      {/* Model/provider are only rendered when the backend actually reports them. */}
      {(metrics.model || metrics.provider) && (
        <div className="grid grid-cols-2 gap-2 border-t pt-2" style={{ borderColor: 'rgba(53,224,255,0.14)' }}>
          {metrics.model && (
            <div className="min-w-0">
              <div className="j-label mb-1">Model</div>
              <div className="j-num truncate text-[11px] text-[color:var(--j-body)]">{metrics.model}</div>
            </div>
          )}
          {metrics.provider && (
            <div className="min-w-0">
              <div className="j-label mb-1">Provider</div>
              <div className="j-num truncate text-[11px] text-[color:var(--j-body)]">{metrics.provider}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
