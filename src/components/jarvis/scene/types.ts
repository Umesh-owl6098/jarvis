/**
 * Visual state enumeration for JARVIS 3D core
 * Maps functional agent state → 3D visual behavior
 */

export type AgentVisualState =
  | 'idle'
  | 'observing'
  | 'planning'
  | 'acting'
  | 'retrying'
  | 'stopping'
  | 'stopped'
  | 'completed'
  | 'failed';

/** Voice states the core reacts to. Agent choreography always takes priority. */
export type VoiceVisualState =
  | 'idle' | 'listening' | 'hearing' | 'processing' | 'accepted'
  | 'paused' | 'muted' | 'denied' | 'unsupported' | 'error';

export interface VisualState {
  agentState: AgentVisualState;
  /** Real voice state; drives ambient reaction only while the agent is idle. */
  voice?: VoiceVisualState;
  stepNumber?: number;
  isRetrying?: boolean;
  progress?: number; // 0-1 for current action
}

/**
 * Electric-cyan system. Hues sit high-chroma so bloom lifts them to white-hot
 * at the centre instead of washing the whole frame to pale blue. Semantic
 * colours (emerald / amber / red) are reserved for real agent outcomes.
 */
export const visualStateColors = {
  idle: { glow: 0x18d8ff, core: 0x03202e, intensity: 0.28 },
  observing: { glow: 0x2ee6ff, core: 0x04303f, intensity: 0.5 },
  planning: { glow: 0x00d5ff, core: 0x032b46, intensity: 0.82 },
  acting: { glow: 0x5df2ff, core: 0x064050, intensity: 1.0 },
  retrying: { glow: 0xffb020, core: 0x3a2606, intensity: 0.66 },
  stopping: { glow: 0xff6a3d, core: 0x3d1206, intensity: 0.55 },
  stopped: { glow: 0x4a6178, core: 0x141c24, intensity: 0.12 },
  completed: { glow: 0x2bf5a0, core: 0x04301f, intensity: 0.85 },
  failed: { glow: 0xff4d5e, core: 0x3d0710, intensity: 0.68 },
} as const;
