/**
 * Voice input contracts.
 *
 * The agent has no idea voice exists: a transcript is normalised into the same
 * string a typed command would produce and handed to the existing submit path.
 * Everything here is input-only — no synthesis, no audio persistence.
 */

export type VoiceState =
  | 'idle' // initialised but not listening (muted, or between cycles)
  | 'listening' // recognition active, waiting for speech
  | 'hearing' // speech detected, still capturing
  | 'processing' // finalising a transcript
  | 'accepted' // command handed to the agent
  | 'paused' // suspended while a task runs
  | 'muted' // user turned the microphone off
  | 'denied' // microphone permission refused
  | 'unsupported' // no speech recognition in this browser
  | 'error'; // recoverable recognition failure

export interface VoiceResult {
  transcript: string;
  isFinal: boolean;
  /** 0–1 when the engine reports it; undefined otherwise. */
  confidence?: number;
}

export type VoiceErrorCode =
  | 'not-supported'
  | 'permission-denied'
  | 'no-microphone'
  | 'no-speech'
  | 'network'
  | 'service-not-allowed'
  | 'aborted'
  | 'unknown';

export interface VoiceError {
  code: VoiceErrorCode;
  message: string;
  /** False for terminal conditions such as a denied permission. */
  recoverable: boolean;
}

export interface SpeechAdapterHandlers {
  onResult(result: VoiceResult): void;
  onSpeechStart?(): void;
  onSpeechEnd?(): void;
  /** Fires whenever a session ends, for any reason. */
  onEnd(): void;
  onError(error: VoiceError): void;
}

/**
 * Minimal surface every recognition backend implements. Keeping this narrow is
 * what lets the deterministic mock exercise the whole pipeline.
 */
export interface SpeechAdapter {
  readonly name: string;
  isSupported(): boolean;
  /** Begin a recognition session. Safe to call when already started. */
  start(handlers: SpeechAdapterHandlers): void;
  /** End the current session. `abort` skips delivering a pending result. */
  stop(abort?: boolean): void;
  dispose(): void;
}

/** Human-readable HUD label for each state. */
export const VOICE_STATE_LABEL: Record<VoiceState, string> = {
  idle: 'Standby',
  listening: 'Listening',
  hearing: 'Hearing',
  processing: 'Processing',
  accepted: 'Command Received',
  paused: 'Paused',
  muted: 'Muted',
  denied: 'Permission Required',
  unsupported: 'Unavailable',
  error: 'Error',
};
