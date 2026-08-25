'use client';

import { StatusLed, type Tone } from './hud/HudKit';
import { VOICE_STATE_LABEL, type VoiceState } from '@/lib/voice/types';

/**
 * Voice status + mute control, sized to sit in the existing top rail.
 *
 * Listening must never be ambiguous: the label always reflects the real
 * adapter state, and muting is one click away.
 */

interface VoiceIndicatorProps {
  state: VoiceState;
  muted: boolean;
  onToggleMute(): void;
  /** Hide the label on narrow viewports where the rail is tight. */
  compact?: boolean;
}

const TONE: Record<VoiceState, Tone> = {
  idle: 'dormant',
  listening: 'accent',
  hearing: 'accent',
  processing: 'accent',
  accepted: 'ok',
  paused: 'dormant',
  muted: 'dormant',
  denied: 'bad',
  unsupported: 'bad',
  error: 'warn',
};

/** States where the microphone is genuinely capturing. */
const LIVE: VoiceState[] = ['listening', 'hearing', 'processing'];

export function VoiceIndicator({ state, muted, onToggleMute, compact = false }: VoiceIndicatorProps) {
  const live = LIVE.includes(state);
  const blocked = state === 'denied' || state === 'unsupported';

  return (
    <div className="flex items-center gap-2">
      {!compact && (
        <div className="flex flex-col items-end gap-[3px]">
          <span className="j-label" style={{ fontSize: '8.5px' }}>
            Voice
          </span>
          <StatusLed tone={TONE[state]} label={VOICE_STATE_LABEL[state]} pulse={live} />
        </div>
      )}

      <button
        type="button"
        onClick={onToggleMute}
        disabled={blocked}
        aria-pressed={muted}
        aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
        title={blocked ? VOICE_STATE_LABEL[state] : muted ? 'Microphone muted' : 'Microphone active'}
        className="j-clip px-2.5 py-1.5 text-[9.5px] font-semibold uppercase tracking-[0.16em] transition-colors disabled:opacity-45"
        style={{
          border: `1px solid ${
            blocked
              ? 'rgba(255,77,94,0.5)'
              : muted
                ? 'rgba(93,116,136,0.45)'
                : 'var(--j-accent)'
          }`,
          background: muted || blocked ? 'transparent' : 'rgba(46,230,255,0.10)',
          color: blocked ? 'var(--j-bad)' : muted ? 'var(--j-mute)' : 'var(--j-accent)',
          ['--j-cut' as string]: '5px',
        }}
      >
        {blocked ? 'Mic ✕' : muted ? 'Mic Off' : 'Mic On'}
      </button>
    </div>
  );
}

/**
 * Live transcript surface. Shows what was heard and exactly what will be
 * submitted — a spoken command is never executed invisibly.
 */
export function VoiceTranscript({
  interim,
  lastRaw,
  lastCommand,
  state,
}: {
  interim: string;
  lastRaw: string;
  lastCommand: string;
  state: VoiceState;
}) {
  const showInterim = interim.trim().length > 0;
  const showAccepted = !showInterim && lastCommand.length > 0 && state !== 'listening';

  if (!showInterim && !showAccepted) return null;

  return (
    <div
      className="mt-2 border-l-2 pl-2.5"
      style={{ borderColor: showInterim ? 'var(--j-accent)' : 'var(--j-ok)' }}
      aria-live="polite"
    >
      <div className="j-label mb-1">{showInterim ? 'Hearing' : 'Voice input'}</div>
      <p className="truncate text-[12px] leading-tight text-[color:var(--j-body)]">
        {showInterim ? interim : lastRaw}
      </p>
      {showAccepted && lastRaw !== lastCommand && (
        <>
          <div className="j-label mb-1 mt-2">Command</div>
          <p className="j-num truncate text-[12px] leading-tight" style={{ color: 'var(--j-accent)' }}>
            {lastCommand}
          </p>
        </>
      )}
    </div>
  );
}
