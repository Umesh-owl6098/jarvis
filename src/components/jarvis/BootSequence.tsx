'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * JARVIS initialization sequence.
 *
 * This is an overlay, not a separate page: the operational 3D core renders
 * beneath it the whole time, so pressing Enter dissolves the boot chrome and
 * reveals the same intelligence core already spinning — one continuous system
 * rather than a landing page that swaps to an app.
 *
 * Everything animated here is transform/opacity only.
 */

export interface BootSequenceProps {
  /** Fired when the operator commits (Enter / Space / click). */
  onInitialize(): void;
  /** Skips choreography for prefers-reduced-motion. */
  reducedMotion: boolean;
}

/** Boot checks. Cosmetic labels — no fake system claims are made. */
const BOOT_LINES: { label: string; detail: string }[] = [
  { label: 'CORE', detail: 'intelligence lattice assembled' },
  { label: 'SCENE', detail: 'spatial environment online' },
  { label: 'ROUTER', detail: 'planner link negotiating' },
  { label: 'BROWSER', detail: 'automation surface armed' },
  { label: 'VOICE', detail: 'awaiting operator authorisation' },
];

type Phase = 'ignition' | 'assembly' | 'checks' | 'identity' | 'ready';

const PHASE_AT: Record<Phase, number> = {
  ignition: 0,
  assembly: 700,
  checks: 1500,
  identity: 3000,
  ready: 3700,
};

export function BootSequence({ onInitialize, reducedMotion }: BootSequenceProps) {
  const [phase, setPhase] = useState<Phase>(reducedMotion ? 'ready' : 'ignition');
  const [visibleChecks, setVisibleChecks] = useState(reducedMotion ? BOOT_LINES.length : 0);
  const [leaving, setLeaving] = useState(false);
  const committed = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const ready = phase === 'ready';

  /* choreography */
  useEffect(() => {
    if (reducedMotion) return;
    const timers = (Object.keys(PHASE_AT) as Phase[]).map((p) =>
      setTimeout(() => setPhase(p), PHASE_AT[p])
    );
    const checkTimers = BOOT_LINES.map((_, i) =>
      setTimeout(() => setVisibleChecks((n) => Math.max(n, i + 1)), PHASE_AT.checks + i * 240)
    );
    return () => [...timers, ...checkTimers].forEach(clearTimeout);
  }, [reducedMotion]);

  /* Enter is the activation gesture; Space and click are equivalents. */
  useEffect(() => {
    const commit = () => {
      if (committed.current || !ready) return;
      committed.current = true;
      setLeaving(true);
      // Let the dissolve play before handing over; reduced motion goes straight through.
      window.setTimeout(onInitialize, reducedMotion ? 0 : 620);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        commit();
      }
    };
    window.addEventListener('keydown', onKey);
    (window as unknown as { __jarvisCommit?: () => void }).__jarvisCommit = commit;
    return () => window.removeEventListener('keydown', onKey);
  }, [ready, onInitialize, reducedMotion]);

  // Move focus to the control as soon as it is actionable, so keyboard and
  // screen-reader users are not stranded behind the animation.
  useEffect(() => {
    if (ready) buttonRef.current?.focus();
  }, [ready]);

  const showFrom = useMemo(
    () => (p: Phase) => (reducedMotion ? true : PHASE_AT[phase] >= PHASE_AT[p]),
    [phase, reducedMotion]
  );

  return (
    <div
      className={`absolute inset-0 z-30 flex flex-col items-center justify-center px-6 ${
        leaving ? 'j-boot-leave' : ''
      }`}
      style={{
        // Veils the operational HUD beneath; the dissolve lifts it away.
        background:
          'radial-gradient(120% 90% at 50% 50%, rgba(4,7,13,0.55) 0%, rgba(4,7,13,0.94) 55%, rgba(4,7,13,0.99) 100%)',
        transition: reducedMotion ? 'none' : 'opacity 600ms ease',
      }}
      role="dialog"
      aria-modal="true"
      aria-label="JARVIS initialization"
    >
      {/* ignition spark — the core beneath is already lit, this focuses the eye */}
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute left-1/2 top-1/2 h-px w-px -translate-x-1/2 -translate-y-1/2 ${
          reducedMotion ? '' : 'j-boot-spark'
        }`}
        style={{
          boxShadow:
            '0 0 40px 12px rgba(46,230,255,0.55), 0 0 140px 60px rgba(46,230,255,0.16)',
          opacity: showFrom('assembly') ? 0 : 1,
          transition: 'opacity 900ms ease',
        }}
      />

      {/* expanding construction rings */}
      {!reducedMotion &&
        [0, 1, 2].map((i) => (
          <span
            key={i}
            aria-hidden="true"
            className="j-boot-ring pointer-events-none absolute left-1/2 top-1/2 rounded-full border"
            style={{
              width: 220 + i * 150,
              height: 220 + i * 150,
              marginLeft: -(110 + i * 75),
              marginTop: -(110 + i * 75),
              borderColor: 'rgba(46,230,255,0.28)',
              animationDelay: `${300 + i * 200}ms`,
              opacity: showFrom('assembly') ? 1 : 0,
            }}
          />
        ))}

      {/* boot checks */}
      <div
        className="mb-10 w-full max-w-[420px]"
        style={{
          opacity: showFrom('checks') ? 1 : 0,
          transition: 'opacity 500ms ease',
        }}
        aria-hidden={!showFrom('checks')}
      >
        {BOOT_LINES.map((line, i) => {
          const shown = i < visibleChecks;
          return (
            <div
              key={line.label}
              className="flex items-baseline justify-between gap-4 border-b py-[7px]"
              style={{
                borderColor: 'rgba(46,230,255,0.10)',
                opacity: shown ? 1 : 0,
                transform: shown ? 'translateY(0)' : 'translateY(4px)',
                transition: 'opacity 320ms ease, transform 320ms ease',
              }}
            >
              <span className="j-label" style={{ color: 'var(--j-accent)' }}>
                {line.label}
              </span>
              <span className="j-label flex-1 truncate text-right" style={{ letterSpacing: '0.08em' }}>
                {line.detail}
              </span>
              <span
                className="j-num text-[10px]"
                style={{ color: shown ? 'var(--j-ok)' : 'var(--j-mute)' }}
              >
                {shown ? 'OK' : '··'}
              </span>
            </div>
          );
        })}
      </div>

      {/* identity */}
      <div
        className="text-center"
        style={{
          opacity: showFrom('identity') ? 1 : 0,
          transform: showFrom('identity') ? 'translateY(0)' : 'translateY(10px)',
          transition: 'opacity 700ms ease, transform 700ms cubic-bezier(0.16,1,0.3,1)',
        }}
      >
        <h1
          className="text-[34px] font-semibold leading-none text-[color:var(--j-ink)] sm:text-[46px]"
          style={{ fontFamily: 'var(--j-mono)', letterSpacing: '0.42em', textIndent: '0.42em' }}
        >
          JARVIS
        </h1>
        <p className="j-label mt-4" style={{ letterSpacing: '0.3em' }}>
          Autonomous Intelligence System
        </p>
      </div>

      {/* activation */}
      <div
        className="mt-12 flex flex-col items-center gap-3"
        style={{
          opacity: ready ? 1 : 0,
          transform: ready ? 'translateY(0)' : 'translateY(8px)',
          transition: 'opacity 500ms ease, transform 500ms ease',
        }}
      >
        <button
          ref={buttonRef}
          type="button"
          disabled={!ready}
          onClick={() =>
            (window as unknown as { __jarvisCommit?: () => void }).__jarvisCommit?.()
          }
          className={`j-clip px-7 py-3 text-[11px] font-semibold uppercase tracking-[0.28em] transition-colors ${
            reducedMotion ? '' : 'j-boot-pulse'
          }`}
          style={{
            border: '1px solid var(--j-accent)',
            background: 'rgba(46,230,255,0.10)',
            color: 'var(--j-accent)',
            ['--j-cut' as string]: '8px',
          }}
        >
          Initialize JARVIS
        </button>
        <kbd className="j-label" style={{ letterSpacing: '0.18em' }}>
          press&nbsp;enter
        </kbd>
        <p className="j-label mt-1 max-w-[320px] text-center" style={{ letterSpacing: '0.08em' }}>
          Initializing requests microphone access for voice commands
        </p>
      </div>

      <p className="sr-only" role="status">
        {ready
          ? 'JARVIS is ready. Press Enter to initialize and enable voice input.'
          : 'JARVIS is initializing.'}
      </p>
    </div>
  );
}
