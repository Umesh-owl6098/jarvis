'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SpeechAdapter, VoiceError, VoiceState } from './types';
import { BrowserSpeechRecognition, requestMicrophoneAccess } from './BrowserSpeechRecognition';
import { normalizeVoiceCommand, type NormalizedCommand } from './normalize';

/**
 * Owns the always-listening loop.
 *
 * Lifecycle: listening → hearing → processing → accepted → paused (task runs)
 * → listening. Recognition is suspended for the whole task so page audio, or
 * our own future speech output, cannot be mistaken for a new command.
 *
 * Nothing here touches audio data: the adapter yields transcript strings only,
 * and no transcript is persisted beyond the current React state.
 */

export interface UseVoiceInputOptions {
  /** Voice stays dormant until JARVIS has been initialised by the user. */
  enabled: boolean;
  /** True while an agent task occupies the system. */
  taskRunning: boolean;
  /** Receives the normalised command; wired to the same submit path as typing. */
  onCommand(command: NormalizedCommand): void;
  /** Swap in the mock adapter for tests. */
  adapterFactory?: () => SpeechAdapter;
  /** Delay before resuming after a task, so the result is readable first. */
  resumeDelayMs?: number;
}

export interface VoiceInputApi {
  state: VoiceState;
  muted: boolean;
  supported: boolean;
  error: VoiceError | null;
  /** Live (interim) transcript, cleared once handled. */
  interim: string;
  /** Last raw transcript that was accepted. */
  lastRaw: string;
  /** Last normalised command that was submitted. */
  lastCommand: string;
  toggleMute(): void;
  /** Called once on Enter: requests permission and starts the loop. */
  initialize(): Promise<void>;
}

const MAX_BACKOFF_MS = 8000;
const BASE_BACKOFF_MS = 400;

export function useVoiceInput(options: UseVoiceInputOptions): VoiceInputApi {
  const { enabled, taskRunning, onCommand, adapterFactory, resumeDelayMs = 1200 } = options;

  const [state, setState] = useState<VoiceState>('idle');
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<VoiceError | null>(null);
  const [interim, setInterim] = useState('');
  const [lastRaw, setLastRaw] = useState('');
  const [lastCommand, setLastCommand] = useState('');
  const [supported, setSupported] = useState(true);

  const adapterRef = useRef<SpeechAdapter | null>(null);
  const restartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failureStreak = useRef(0);
  const disposed = useRef(false);

  // Mirrors of reactive values, so the adapter callbacks always read current
  // truth without being re-registered on every render.
  const mutedRef = useRef(muted);
  const taskRef = useRef(taskRunning);
  const enabledRef = useRef(enabled);
  const initializedRef = useRef(false);
  const onCommandRef = useRef(onCommand);

  useEffect(() => void (mutedRef.current = muted), [muted]);
  useEffect(() => void (taskRef.current = taskRunning), [taskRunning]);
  useEffect(() => void (enabledRef.current = enabled), [enabled]);
  useEffect(() => void (onCommandRef.current = onCommand), [onCommand]);

  const clearRestart = useCallback(() => {
    if (restartTimer.current) {
      clearTimeout(restartTimer.current);
      restartTimer.current = null;
    }
  }, []);

  /** May the microphone be live right now? */
  const shouldListen = useCallback(
    () =>
      !disposed.current &&
      initializedRef.current &&
      enabledRef.current &&
      !mutedRef.current &&
      !taskRef.current,
    []
  );

  const beginSession = useCallback(() => {
    const adapter = adapterRef.current;
    if (!adapter || !shouldListen()) return;

    setState('listening');
    adapter.start({
      onSpeechStart: () => setState((s) => (s === 'listening' ? 'hearing' : s)),
      onSpeechEnd: () => setState((s) => (s === 'hearing' ? 'processing' : s)),

      onResult: (result) => {
        if (!result.isFinal) {
          setInterim(result.transcript);
          setState((s) => (s === 'listening' ? 'hearing' : s));
          return;
        }

        const normalized = normalizeVoiceCommand(result.transcript);
        setInterim('');
        failureStreak.current = 0;

        // Nothing actionable (silence, or a bare wake word) — keep listening.
        if (!normalized.submittable) {
          setState('listening');
          return;
        }

        setLastRaw(normalized.raw);
        setLastCommand(normalized.command);
        setState('accepted');

        // Development-only evidence trail for real-microphone verification:
        // records what the engine heard vs what will be submitted. Transcript
        // text only — no audio is captured, buffered or stored anywhere.
        if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
          const w = window as unknown as { __jarvisVoiceLog?: unknown[] };
          w.__jarvisVoiceLog = w.__jarvisVoiceLog || [];
          w.__jarvisVoiceLog.push({
            at: new Date().toISOString(),
            adapter: adapterRef.current?.name ?? 'unknown',
            raw: normalized.raw,
            normalized: normalized.command,
            hadWakeWord: normalized.hadWakeWord,
            confidence: result.confidence ?? null,
          });
          console.log(
            `[voice] adapter=${adapterRef.current?.name} raw=${JSON.stringify(normalized.raw)} -> normalized=${JSON.stringify(normalized.command)}`
          );
        }

        // Suspend before handing over: the task owns the system from here.
        adapter.stop(true);
        onCommandRef.current(normalized);
      },

      onError: (err) => {
        // A no-speech timeout is the normal outcome of a quiet room.
        if (err.code === 'no-speech' || err.code === 'aborted') return;

        setError(err);
        if (!err.recoverable) {
          setState(err.code === 'permission-denied' ? 'denied' : 'unsupported');
          return;
        }
        failureStreak.current += 1;
        setState('error');
      },

      onEnd: () => {
        if (!shouldListen()) {
          setState((s) => (s === 'accepted' ? s : mutedRef.current ? 'muted' : 'paused'));
          return;
        }
        // Chrome ends sessions on its own; restart with bounded backoff so a
        // persistent failure cannot spin.
        const delay = Math.min(
          BASE_BACKOFF_MS * Math.pow(2, Math.max(0, failureStreak.current - 1)),
          MAX_BACKOFF_MS
        );
        clearRestart();
        restartTimer.current = setTimeout(() => {
          if (shouldListen()) beginSession();
        }, failureStreak.current > 0 ? delay : 250);
      },
    });
  }, [clearRestart, shouldListen]);

  /** Enter pressed: ask for the microphone, then start listening. */
  const initialize = useCallback(async () => {
    if (initializedRef.current) return;

    const adapter = adapterFactory ? adapterFactory() : new BrowserSpeechRecognition();
    adapterRef.current = adapter;

    if (!adapter.isSupported()) {
      setSupported(false);
      setState('unsupported');
      setError({
        code: 'not-supported',
        message: 'Speech recognition is not available in this browser',
        recoverable: false,
      });
      return;
    }

    // Only meaningful for the real browser adapter; the mock has no permission.
    if (!adapterFactory) {
      const grant = await requestMicrophoneAccess();
      if (!grant.granted) {
        setError(grant.error);
        setState(grant.error.code === 'permission-denied' ? 'denied' : 'unsupported');
        return;
      }
    }

    // `enabled` is driven by React state that has not committed yet when Enter
    // calls this, so its mirror can still read false. Initialization IS the
    // activation, so assert it here rather than racing the effect.
    initializedRef.current = true;
    enabledRef.current = true;
    setError(null);
    beginSession();
  }, [adapterFactory, beginSession]);

  const toggleMute = useCallback(() => {
    setMuted((wasMuted) => {
      const next = !wasMuted;
      mutedRef.current = next;
      if (next) {
        clearRestart();
        adapterRef.current?.stop(true);
        setInterim('');
        setState('muted');
      } else {
        setState('idle');
        // Resume on the next tick so the adapter has fully torn down.
        clearRestart();
        restartTimer.current = setTimeout(() => beginSession(), 150);
      }
      return next;
    });
  }, [beginSession, clearRestart]);

  /* Pause for the duration of a task, resume shortly after it resolves. */
  useEffect(() => {
    if (!initializedRef.current) return;

    if (taskRunning) {
      clearRestart();
      adapterRef.current?.stop(true);
      setInterim('');
      setState('paused');
      return;
    }

    if (!shouldListen()) return;
    clearRestart();
    restartTimer.current = setTimeout(() => {
      if (shouldListen()) beginSession();
    }, resumeDelayMs);

    return clearRestart;
  }, [taskRunning, beginSession, clearRestart, resumeDelayMs, shouldListen]);

  /* Stop cleanly when the operational view goes away. */
  useEffect(() => {
    // React StrictMode mounts, cleans up, then mounts again in development.
    // Without resetting this the first cleanup would permanently mark the hook
    // disposed and the microphone would never start.
    disposed.current = false;
    return () => {
      disposed.current = true;
      clearRestart();
      adapterRef.current?.dispose();
      adapterRef.current = null;
    };
  }, [clearRestart]);

  return {
    state,
    muted,
    supported,
    error,
    interim,
    lastRaw,
    lastCommand,
    toggleMute,
    initialize,
  };
}
