'use client';

import { useRef, useState } from 'react';

interface CommandComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClear?: () => void;
  onStop?: () => void;
  disabled: boolean;
  showClear: boolean;
  isStopping?: boolean;
  /** Real agent phase, shown live in the terminal gutter. */
  phase?: string;
}

export function CommandComposer({
  value,
  onChange,
  onSubmit,
  onClear,
  onStop,
  disabled,
  showClear,
  isStopping,
  phase = 'idle',
}: CommandComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  const accent = disabled ? 'var(--j-warn)' : 'var(--j-accent)';

  return (
    <div className="relative">
      {/* input field with a live prompt gutter */}
      <div
        className="relative flex items-stretch border transition-colors duration-200"
        style={{
          borderColor: focused ? accent : `${accent}33`,
          background: 'rgba(4, 9, 17, 0.72)',
          boxShadow: focused ? `0 0 0 1px ${accent}44, 0 0 22px -8px ${accent}` : 'none',
        }}
      >
        <div
          className="flex w-11 shrink-0 flex-col items-center justify-center border-r"
          style={{ borderColor: `${accent}22`, background: `${accent}0a` }}
        >
          <span className="j-num text-[13px]" style={{ color: accent }} aria-hidden="true">
            {disabled ? '▶' : '›'}
          </span>
          <span className="j-label mt-1 text-center" style={{ fontSize: '7.5px', letterSpacing: '0.08em' }}>
            {phase.slice(0, 4).toUpperCase()}
          </span>
        </div>

        <label htmlFor="jarvis-command" className="sr-only">
          Command for the JARVIS agent
        </label>
        <textarea
          id="jarvis-command"
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Open example.com and tell me the page title…"
          disabled={disabled}
          rows={2}
          spellCheck={false}
          autoComplete="off"
          className="j-num w-full resize-none bg-transparent px-3 py-2.5 text-[12.5px] leading-[1.6] text-[color:var(--j-ink)] placeholder-[color:var(--j-mute)] outline-none disabled:opacity-45"
          style={{ letterSpacing: '0.005em' }}
        />
      </div>

      {/* control rail */}
      <div className="mt-2 flex items-center gap-2">
        {disabled && onStop ? (
          <button
            type="button"
            onClick={onStop}
            disabled={isStopping}
            className="j-clip flex-1 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.18em] transition-opacity disabled:opacity-60"
            style={{
              background: 'rgba(255, 77, 94, 0.16)',
              border: '1px solid rgba(255, 77, 94, 0.55)',
              color: 'var(--j-bad)',
              ['--j-cut' as string]: '6px',
            }}
          >
            {isStopping ? 'Halting…' : 'Abort Execution'}
          </button>
        ) : (
          <button
            type="button"
            onClick={onSubmit}
            disabled={disabled || !value.trim()}
            className="j-clip flex-1 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.18em] transition-opacity disabled:opacity-60"
            style={{
              background: value.trim() ? 'rgba(53, 224, 255, 0.18)' : 'rgba(53, 224, 255, 0.06)',
              border: `1px solid ${value.trim() ? 'var(--j-accent)' : 'rgba(53, 224, 255, 0.34)'}`,
              color: value.trim() ? 'var(--j-accent)' : 'var(--j-mute)',
              ['--j-cut' as string]: '6px',
            }}
          >
            Execute
          </button>
        )}

        {showClear && onClear && (
          <button
            type="button"
            onClick={onClear}
            className="j-clip px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] transition-colors"
            style={{
              border: '1px solid rgba(93, 116, 136, 0.4)',
              color: 'var(--j-body)',
              ['--j-cut' as string]: '6px',
            }}
          >
            Reset
          </button>
        )}

        <kbd className="j-label hidden shrink-0 whitespace-nowrap lg:block" style={{ letterSpacing: '0.1em' }}>
          ⏎&nbsp;send · ⇧⏎&nbsp;newline
        </kbd>
      </div>
    </div>
  );
}
