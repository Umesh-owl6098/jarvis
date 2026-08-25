'use client';

import type {
  SpeechAdapter,
  SpeechAdapterHandlers,
  VoiceError,
  VoiceErrorCode,
} from './types';

/**
 * Web Speech API adapter.
 *
 * Privacy: this is the browser's own recogniser. In Chrome it streams audio to
 * Google's speech service — it is NOT local, and we do not claim otherwise. We
 * never obtain, buffer, or persist the audio ourselves; only the resulting
 * transcript string reaches application code.
 */

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error?: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<
    ArrayLike<{ transcript: string; confidence?: number }> & { isFinal: boolean }
  >;
}

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition || w.webkitSpeechRecognition || null) as SpeechRecognitionCtor | null;
}

/** Map the spec's terse error strings onto our vocabulary. */
function mapError(code: string | undefined): VoiceError {
  const map: Record<string, { code: VoiceErrorCode; message: string; recoverable: boolean }> = {
    'not-allowed': {
      code: 'permission-denied',
      message: 'Microphone permission was refused',
      recoverable: false,
    },
    'service-not-allowed': {
      code: 'service-not-allowed',
      message: 'The browser blocked its speech service',
      recoverable: false,
    },
    'audio-capture': {
      code: 'no-microphone',
      message: 'No microphone was available',
      recoverable: false,
    },
    'no-speech': { code: 'no-speech', message: 'No speech detected', recoverable: true },
    network: { code: 'network', message: 'Speech service unreachable', recoverable: true },
    aborted: { code: 'aborted', message: 'Recognition aborted', recoverable: true },
  };
  const hit = code ? map[code] : undefined;
  return hit ?? { code: 'unknown', message: code || 'Recognition failed', recoverable: true };
}

export class BrowserSpeechRecognition implements SpeechAdapter {
  readonly name = 'web-speech-api';

  private recognition: SpeechRecognitionLike | null = null;
  private handlers: SpeechAdapterHandlers | null = null;
  private running = false;
  /** Set while we deliberately stop, so onend is not treated as a dropout. */
  private stopping = false;

  constructor(private readonly lang = 'en-US') {}

  isSupported(): boolean {
    return getCtor() !== null;
  }

  start(handlers: SpeechAdapterHandlers): void {
    this.handlers = handlers;

    const Ctor = getCtor();
    if (!Ctor) {
      handlers.onError({
        code: 'not-supported',
        message: 'This browser has no Web Speech API',
        recoverable: false,
      });
      return;
    }
    if (this.running) return;

    const rec = new Ctor();
    rec.lang = this.lang;
    // `continuous` keeps a session open across pauses where supported; the
    // owning hook still restarts on end, because Chrome ends sessions anyway.
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      this.running = true;
      this.stopping = false;
    };

    rec.onspeechstart = () => handlers.onSpeechStart?.();
    rec.onspeechend = () => handlers.onSpeechEnd?.();

    rec.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const alt = result[0];
        if (!alt) continue;
        handlers.onResult({
          transcript: alt.transcript,
          isFinal: Boolean(result.isFinal),
          confidence: alt.confidence,
        });
      }
    };

    rec.onerror = (event) => {
      const err = mapError(event?.error);
      // A no-speech timeout is normal in an always-listening loop; the hook
      // decides whether to restart rather than surfacing noise to the user.
      handlers.onError(err);
    };

    rec.onend = () => {
      this.running = false;
      handlers.onEnd();
    };

    this.recognition = rec;
    try {
      rec.start();
    } catch {
      // start() throws if a session is already live — harmless.
      this.running = true;
    }
  }

  stop(abort = false): void {
    const rec = this.recognition;
    if (!rec) return;
    this.stopping = true;
    try {
      if (abort) {
        rec.abort();
        // abort() is not guaranteed to emit `onend`, and `running` is otherwise
        // only cleared there. Leaving it set makes every later start() a no-op,
        // so the microphone would never come back after a voice command.
        this.running = false;
      } else {
        rec.stop();
      }
    } catch {
      // already stopped
    }
  }

  dispose(): void {
    const rec = this.recognition;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      rec.onstart = null;
      rec.onspeechstart = null;
      rec.onspeechend = null;
      try {
        rec.abort();
      } catch {
        // ignore
      }
    }
    this.recognition = null;
    this.handlers = null;
    this.running = false;
  }
}

/**
 * Ask for microphone access explicitly so the permission prompt appears at a
 * moment the user caused (pressing Enter), rather than mid-animation. The
 * stream is stopped immediately — we only need the grant, never the audio.
 */
export async function requestMicrophoneAccess(): Promise<
  { granted: true } | { granted: false; error: VoiceError }
> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return {
      granted: false,
      error: { code: 'not-supported', message: 'No media devices API', recoverable: false },
    };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return { granted: true };
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return {
        granted: false,
        error: {
          code: 'permission-denied',
          message: 'Microphone permission was refused',
          recoverable: false,
        },
      };
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return {
        granted: false,
        error: { code: 'no-microphone', message: 'No microphone found', recoverable: false },
      };
    }
    return {
      granted: false,
      error: { code: 'unknown', message: name || 'Microphone unavailable', recoverable: true },
    };
  }
}
