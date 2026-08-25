'use client';

import type { ReactNode } from 'react';

/* ============================================================
   HUD kit — the shared instrumentation language.
   Angular clipped frames, hairline illuminated borders, corner
   markers, technical labels, tabular readouts.
   ============================================================ */

export type Tone = 'accent' | 'ok' | 'warn' | 'bad' | 'dormant';

const TONE_COLOR: Record<Tone, string> = {
  accent: 'var(--j-accent)',
  ok: 'var(--j-ok)',
  warn: 'var(--j-warn)',
  bad: 'var(--j-bad)',
  dormant: 'var(--j-dormant)',
};

export function toneColor(tone: Tone) {
  return TONE_COLOR[tone];
}

/* ---------- Panel ---------- */

interface HudPanelProps {
  label: string;
  /** Right-aligned micro status in the header rail. */
  status?: ReactNode;
  tone?: Tone;
  /** Animated sweep line — reserved for panels tied to live execution. */
  active?: boolean;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

export function HudPanel({
  label,
  status,
  tone = 'accent',
  active = false,
  className = '',
  bodyClassName = '',
  children,
}: HudPanelProps) {
  const c = TONE_COLOR[tone];

  return (
    <section
      className={`j-frame j-clip relative ${className}`}
      style={
        {
          background: `linear-gradient(155deg, ${c}cc, ${c}26 42%, ${c}18 68%, ${c}88)`,
        } as React.CSSProperties
      }
    >
      <div className="j-clip j-grid-tex relative flex h-full min-h-0 flex-col overflow-hidden bg-[rgba(8,17,29,0.90)] backdrop-blur-[7px]">
        {/* top-edge highlight: reads as a lit bevel */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-px"
          style={{ background: `linear-gradient(90deg, transparent, ${c}99 25%, ${c}99 75%, transparent)` }}
        />

        {/* corner markers */}
        <Corner className="left-0 top-0" style={{ borderColor: c }} edges="tl" />
        <Corner className="right-0 top-0" style={{ borderColor: c }} edges="tr" />
        <Corner className="right-0 bottom-0" style={{ borderColor: c }} edges="br" />

        {/* header rail */}
        <header
          className="flex shrink-0 items-center justify-between gap-3 border-b px-3.5 py-2.5"
          style={{ borderColor: `${c}3d`, background: `${c}14` }}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="h-[3px] w-[3px] shrink-0"
              style={{ background: c, boxShadow: `0 0 6px ${c}` }}
            />
            <h2
              className="j-label truncate"
              style={{ color: c, letterSpacing: '0.16em', fontSize: '10.5px' }}
            >
              {label}
            </h2>
          </div>
          {status ? <div className="shrink-0">{status}</div> : null}
        </header>

        {/* live sweep */}
        {active ? (
          <div className="pointer-events-none absolute inset-x-0 top-8 h-16 overflow-hidden" aria-hidden="true">
            <div
              className="j-scanline h-px w-full"
              style={{ background: `linear-gradient(90deg, transparent, ${c}, transparent)` }}
            />
          </div>
        ) : null}

        <div className={`relative min-h-0 flex-1 px-3.5 py-3 ${bodyClassName}`}>{children}</div>
      </div>
    </section>
  );
}

function Corner({
  className,
  style,
  edges,
}: {
  className: string;
  style: React.CSSProperties;
  edges: 'tl' | 'tr' | 'br';
}) {
  const borders =
    edges === 'tl'
      ? 'border-l border-t'
      : edges === 'tr'
        ? 'border-r border-t'
        : 'border-r border-b';
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute z-10 h-2 w-2 ${borders} ${className}`}
      style={style}
    />
  );
}

/* ---------- Readouts ---------- */

export function Readout({
  label,
  value,
  tone = 'accent',
  mono = true,
  title,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="j-label mb-1 truncate">{label}</div>
      <div
        className={`${mono ? 'j-num' : ''} truncate text-[13.5px] leading-tight`}
        style={{ color: TONE_COLOR[tone] }}
        title={title}
      >
        {value}
      </div>
    </div>
  );
}

/** Large stat used in the execution rail. */
export function Stat({
  label,
  value,
  unit,
  tone = 'accent',
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  tone?: Tone;
}) {
  return (
    <div className="min-w-0">
      <div className="j-label mb-1 truncate">{label}</div>
      <div className="flex items-baseline gap-1">
        <span className="j-num text-[21px] leading-none" style={{ color: TONE_COLOR[tone] }}>
          {value}
        </span>
        {unit ? <span className="j-label" style={{ letterSpacing: '0.08em' }}>{unit}</span> : null}
      </div>
    </div>
  );
}

/* ---------- Status LED ---------- */

export function StatusLed({
  tone,
  label,
  pulse = false,
}: {
  tone: Tone;
  label: string;
  pulse?: boolean;
}) {
  const c = TONE_COLOR[tone];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`h-[6px] w-[6px] rounded-full ${pulse ? 'j-blink' : ''}`}
        style={{ background: c, boxShadow: `0 0 7px ${c}` }}
        aria-hidden="true"
      />
      <span className="j-label" style={{ color: c, letterSpacing: '0.1em', fontSize: '10px' }}>
        {label}
      </span>
    </span>
  );
}

/* ---------- Separator ---------- */

export function HudRule({ tone = 'accent' }: { tone?: Tone }) {
  return (
    <div
      className="my-2 h-px w-full"
      style={{
        background: `linear-gradient(90deg, ${TONE_COLOR[tone]}33, transparent 70%)`,
      }}
      aria-hidden="true"
    />
  );
}

/* ---------- Step ladder ---------- */

/**
 * Discrete step meter. `total` is the agent's real max-step ceiling;
 * `current` is the real step number from SSE.
 */
export function StepLadder({ current, total }: { current: number; total: number }) {
  const cells = Array.from({ length: total }, (_, i) => i < current);
  return (
    <div className="flex gap-[2px]" role="img" aria-label={`Step ${current} of ${total}`}>
      {cells.map((filled, i) => (
        <span
          key={i}
          className="h-[13px] flex-1"
          style={{
            background: filled ? 'var(--j-accent)' : 'rgba(53,224,255,0.11)',
            boxShadow: filled ? '0 0 5px rgba(53,224,255,0.55)' : 'none',
          }}
        />
      ))}
    </div>
  );
}

/* ---------- Counter chips (real event tallies) ---------- */

export function CounterChip({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: Tone;
}) {
  const active = count > 0;
  const c = active ? TONE_COLOR[tone] : 'var(--j-dormant)';
  return (
    <div
      className="flex items-center justify-between gap-2 border px-2 py-1.5"
      style={{ borderColor: `${c}2e`, background: `${c}0a` }}
    >
      <span className="j-label truncate" style={{ letterSpacing: '0.1em' }}>
        {label}
      </span>
      <span className="j-num text-[13px] leading-none" style={{ color: c }}>
        {count}
      </span>
    </div>
  );
}
