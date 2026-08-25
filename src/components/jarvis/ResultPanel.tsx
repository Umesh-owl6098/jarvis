'use client';

import type { TaskUiStatus } from './types';

interface ResultPanelProps {
  status: TaskUiStatus;
  result: string;
}

export function ResultPanel({ status, result }: ResultPanelProps) {
  if (status === 'idle' || status === 'running' || status === 'stopping' || !result) return null;

  const tone =
    status === 'failed'
      ? { c: 'var(--j-bad)', label: 'Fault report' }
      : status === 'stopped'
        ? { c: 'var(--j-warn)', label: 'Halted at operator request' }
        : { c: 'var(--j-ok)', label: 'Returned payload' };

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5">
        <span
          className="h-[3px] w-[3px]"
          style={{ background: tone.c, boxShadow: `0 0 6px ${tone.c}` }}
          aria-hidden="true"
        />
        <span className="j-label" style={{ color: tone.c }}>
          {tone.label}
        </span>
      </div>
      <p
        className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words border-l pl-2.5 text-[12.5px] leading-[1.55] j-scroll"
        style={{ borderColor: `${tone.c}55`, color: 'var(--j-ink)' }}
      >
        {result}
      </p>
    </div>
  );
}
