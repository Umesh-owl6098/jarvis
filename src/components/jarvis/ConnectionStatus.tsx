'use client';

import type { RouterStatus } from '@/core/router/runtime-status';
import { StatusLed, type Tone } from './hud/HudKit';

interface ConnectionStatusProps {
  status: RouterStatus | 'checking';
  isRunning: boolean;
  /** Real round-trip latency from /api/omniroute/health. */
  latencyMs?: number | null;
}

// Reachability alone is not health: a reachable router whose generation calls
// are returning 429 must never read ONLINE.
const STATUS_CONFIG: Record<string, { tone: Tone; label: string }> = {
  checking: { tone: 'dormant', label: 'Probing' },
  online: { tone: 'ok', label: 'Online' },
  rate_limited: { tone: 'warn', label: 'Rate Limited' },
  degraded: { tone: 'warn', label: 'Degraded' },
  offline: { tone: 'bad', label: 'Offline' },
};

export function ConnectionStatus({ status, isRunning, latencyMs }: ConnectionStatusProps) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.checking;

  return (
    <div className="flex items-center gap-3">
      <div className="flex flex-col items-end gap-[3px]">
        <span className="j-label" style={{ fontSize: '8.5px' }}>
          OmniRoute
        </span>
        <StatusLed tone={config.tone} label={config.label} pulse={status === 'checking'} />
      </div>

      <span className="hidden h-6 w-px sm:block" style={{ background: 'rgba(53,224,255,0.16)' }} aria-hidden="true" />

      <div className="hidden flex-col items-end gap-[3px] sm:flex">
        <span className="j-label" style={{ fontSize: '8.5px' }}>
          Latency
        </span>
        <span
          className="j-num text-[11px] leading-none"
          style={{ color: latencyMs == null ? 'var(--j-dormant)' : 'var(--j-accent)' }}
        >
          {latencyMs == null ? '—' : `${latencyMs} ms`}
        </span>
      </div>

      <span className="hidden h-6 w-px md:block" style={{ background: 'rgba(53,224,255,0.16)' }} aria-hidden="true" />

      <div className="hidden flex-col items-end gap-[3px] md:flex">
        <span className="j-label" style={{ fontSize: '8.5px' }}>
          Agent
        </span>
        <StatusLed
          tone={isRunning ? 'warn' : 'dormant'}
          label={isRunning ? 'Executing' : 'Standby'}
          pulse={isRunning}
        />
      </div>
    </div>
  );
}
