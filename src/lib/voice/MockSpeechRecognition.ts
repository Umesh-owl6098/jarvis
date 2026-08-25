import type { SpeechAdapter, SpeechAdapterHandlers, VoiceError, VoiceResult } from './types';

/**
 * Deterministic speech adapter for tests.
 *
 * Drives the exact same pipeline as the browser adapter, so a test can prove
 * transcript → normalisation → submission without a microphone, a network
 * speech service, or any audio at all.
 */
export class MockSpeechRecognition implements SpeechAdapter {
  readonly name = 'mock';

  private handlers: SpeechAdapterHandlers | null = null;
  private started = false;

  /** Every session start, in order — lets tests assert restart behaviour. */
  readonly startLog: number[] = [];
  readonly stopLog: { at: number; abort: boolean }[] = [];

  constructor(private readonly supported = true) {}

  isSupported(): boolean {
    return this.supported;
  }

  get isRunning(): boolean {
    return this.started;
  }

  start(handlers: SpeechAdapterHandlers): void {
    this.handlers = handlers;
    if (!this.supported) {
      handlers.onError({
        code: 'not-supported',
        message: 'Mock adapter configured as unsupported',
        recoverable: false,
      });
      return;
    }
    this.started = true;
    this.startLog.push(Date.now());
  }

  stop(abort = false): void {
    if (!this.started) return;
    this.started = false;
    this.stopLog.push({ at: Date.now(), abort });
    if (!abort) this.handlers?.onEnd();
  }

  dispose(): void {
    this.started = false;
    this.handlers = null;
  }

  /* ---------------- test drivers ---------------- */

  /** Emit an interim (non-final) transcript. */
  say(transcript: string): void {
    this.handlers?.onSpeechStart?.();
    this.emit({ transcript, isFinal: false });
  }

  /** Emit a final transcript, as the browser would at end of utterance. */
  finalize(transcript: string, confidence = 0.95): void {
    this.emit({ transcript, isFinal: true, confidence });
    this.handlers?.onSpeechEnd?.();
  }

  /** Speak and finalise in one step. */
  speak(transcript: string): void {
    this.say(transcript);
    this.finalize(transcript);
  }

  /** Simulate the engine ending a session by itself (Chrome does this). */
  endSession(): void {
    this.started = false;
    this.handlers?.onEnd();
  }

  fail(error: VoiceError): void {
    this.handlers?.onError(error);
  }

  private emit(result: VoiceResult): void {
    this.handlers?.onResult(result);
  }
}
