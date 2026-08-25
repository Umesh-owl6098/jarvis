'use client';

import { useEffect, useRef, useState } from 'react';
import type { BrowserUiState } from './types';
import { Readout, StatusLed, type Tone } from './hud/HudKit';

interface BrowserPanelProps {
  browser: BrowserUiState;
}

const STATUS: Record<BrowserUiState['status'], { tone: Tone; label: string }> = {
  idle: { tone: 'dormant', label: 'Idle' },
  loading: { tone: 'warn', label: 'Loading' },
  ready: { tone: 'ok', label: 'Ready' },
};

export function BrowserPanel({ browser }: BrowserPanelProps) {
  const s = STATUS[browser.status];
  const [scanning, setScanning] = useState(false);
  const lastUrl = useRef(browser.url);

  // real browser.state.changed → short scan response, not a permanent loop
  useEffect(() => {
    if (browser.url && browser.url !== lastUrl.current) {
      lastUrl.current = browser.url;
      setScanning(true);
      const id = setTimeout(() => setScanning(false), 1100);
      return () => clearTimeout(id);
    }
  }, [browser.url]);

  const host = (() => {
    if (!browser.url) return null;
    try {
      return new URL(browser.url).host;
    } catch {
      return null;
    }
  })();

  return (
    <div className="space-y-2.5">
      {/* viewport stand-in: origin + scan response */}
      <div
        className="relative overflow-hidden border px-2.5 py-2"
        style={{
          borderColor: scanning ? 'var(--j-accent)' : 'rgba(53,224,255,0.18)',
          background: 'rgba(53,224,255,0.045)',
          transition: 'border-color 220ms ease',
        }}
      >
        {scanning && (
          <span
            aria-hidden="true"
            className="j-scanline pointer-events-none absolute inset-x-0 top-0 h-px"
            style={{ background: 'linear-gradient(90deg, transparent, var(--j-accent), transparent)' }}
          />
        )}
        <div className="j-label mb-1">Origin</div>
        <div className="j-num truncate text-[12px] text-[color:var(--j-accent)]" title={browser.url || undefined}>
          {host || '—'}
        </div>
      </div>

      <Readout label="URL" value={browser.url || '—'} tone="accent" title={browser.url || undefined} />
      <Readout label="Document title" value={browser.title || '—'} tone="accent" mono={false} title={browser.title || undefined} />

      <div className="flex items-center justify-between pt-0.5">
        <span className="j-label">Channel</span>
        <StatusLed tone={s.tone} label={s.label} pulse={browser.status === 'loading'} />
      </div>
    </div>
  );
}
