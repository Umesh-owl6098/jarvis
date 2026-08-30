'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  CommandComposer,
  ActivityTimeline,
  BrowserPanel,
  ResultPanel,
  MetricsBar,
  ConnectionStatus,
  DeveloperInspector,
} from '@/components/jarvis';
import {
  HudPanel,
  Readout,
  StatusLed,
  StepLadder,
  CounterChip,
  toneColor,
  type Tone,
} from '@/components/jarvis/hud/HudKit';
import { streamAgentTask } from '@/lib/agent-stream';
import { BootSequence } from '@/components/jarvis/BootSequence';
import { VoiceIndicator, VoiceTranscript } from '@/components/jarvis/VoiceIndicator';
import { useVoiceInput } from '@/lib/voice/useVoiceInput';
import type { NormalizedCommand } from '@/lib/voice/normalize';
import { JarvisScene } from '@/components/jarvis/scene/JarvisScene';
import { type VisualState, type AgentVisualState } from '@/components/jarvis/scene/types';
import type { SceneQuality } from '@/components/jarvis/scene/JarvisCore3D';
import type { TaskUiState, BrowserUiState, TaskMetrics } from '@/components/jarvis';
import type { RouterStatus } from '@/core/router/runtime-status';

const EMPTY_BROWSER: BrowserUiState = { url: '', title: '', status: 'idle' };
const EMPTY_METRICS: TaskMetrics = { durationMs: null, steps: 0, tokens: 0 };

/** Mirrors AgentExecutor's maxSteps default — used only to scale the step ladder. */
const MAX_STEPS = 15;

const PHASE_TONE: Record<AgentVisualState, Tone> = {
  idle: 'dormant',
  observing: 'accent',
  planning: 'accent',
  acting: 'accent',
  retrying: 'warn',
  stopping: 'warn',
  stopped: 'dormant',
  completed: 'ok',
  failed: 'bad',
};

const PHASE_LABEL: Record<AgentVisualState, string> = {
  idle: 'Idle',
  observing: 'Observing',
  planning: 'Planning',
  acting: 'Acting',
  retrying: 'Retrying',
  stopping: 'Stopping',
  stopped: 'Stopped',
  completed: 'Completed',
  failed: 'Failed',
};

/** Human labels for the "current operation" readout — real event types only. */
const EVENT_LABEL: Record<string, string> = {
  'task.started': 'Task started',
  'task.stopped': 'Task stopped',
  'browser.initialized': 'Browser initialized',
  'browser.navigated': 'Browser navigated',
  'browser.state.changed': 'Page state captured',
  'agent.observing': 'Observing page',
  'agent.planning': 'Planning next action',
  'agent.action.started': 'Executing action',
  'agent.action.completed': 'Action completed',
  'agent.action.failed': 'Action failed',
  'agent.recovery': 'Recovery attempt',
  'router.retry': 'Router retry',
  'agent.completed': 'Task completed',
  'agent.failed': 'Task failed',
};

/** Human text for the router status readout. */
const ROUTER_STATUS_TEXT: Record<string, string> = {
  checking: 'Checking…',
  online: 'online',
  rate_limited: 'rate limited',
  degraded: 'degraded',
  offline: 'offline',
};

type Breakpoint = 'sm' | 'md' | 'lg' | 'xl';

export default function Home() {
  const [input, setInput] = useState('');
  const [task, setTask] = useState<TaskUiState | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [showDevMode, setShowDevMode] = useState(false);
  const [healthStatus, setHealthStatus] = useState<RouterStatus | 'checking'>('checking');
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [routerLabel, setRouterLabel] = useState<string>('—');
  const [routerIsMock, setRouterIsMock] = useState(false);
  const [visualState, setVisualState] = useState<VisualState>({ agentState: 'idle' });
  const [bp, setBp] = useState<Breakpoint>('xl');
  const [liveMs, setLiveMs] = useState<number | null>(null);
  const [clock, setClock] = useState<string>('');
  const [sheet, setSheet] = useState<'none' | 'trace' | 'browser' | 'result'>('none');
  /** null until we've read sessionStorage — avoids flashing the boot overlay. */
  const [booted, setBooted] = useState<boolean | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  const taskIdRef = useRef<string | null>(null);
  const startedAtRef = useRef<number>(0);

  /* ---------- boot gate ---------- */
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener('change', onChange);

    // Dev-only escape hatch so automated tests need not sit through the intro.
    const skip =
      process.env.NODE_ENV !== 'production' &&
      new URLSearchParams(window.location.search).get('skipIntro') === '1';

    // Per-session, not permanent: a new tab boots again.
    const already = window.sessionStorage.getItem('jarvisInitialized') === 'true';
    setBooted(skip || already);

    return () => mq.removeEventListener('change', onChange);
  }, []);

  /* ---------- viewport tier (drives layout AND 3D cost) ---------- */
  useEffect(() => {
    const measure = () => {
      const w = window.innerWidth;
      setBp(w < 768 ? 'sm' : w < 1024 ? 'md' : w < 1440 ? 'lg' : 'xl');
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const quality: SceneQuality = bp === 'sm' ? 'low' : bp === 'md' ? 'medium' : 'high';

  /* ---------- system clock ---------- */
  useEffect(() => {
    const tick = () =>
      setClock(
        new Date().toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      );
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  /* ---------- live elapsed while running (1 Hz, not per frame) ---------- */
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setLiveMs(Date.now() - startedAtRef.current), 100);
    return () => clearInterval(id);
  }, [isRunning]);

  /* ---------- OmniRoute health (reachability + generation capacity) ---------- */
  const refreshHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/omniroute/health');
      const data = await res.json();
      setHealthStatus(data.status);
      setLatencyMs(typeof data.latencyMs === 'number' ? data.latencyMs : null);
      setRouterLabel(typeof data.routerLabel === 'string' ? data.routerLabel : '—');
      setRouterIsMock(data.isMock === true);
    } catch {
      setHealthStatus('offline');
      setLatencyMs(null);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    const check = async () => {
      try {
        const res = await fetch('/api/omniroute/health');
        const data = await res.json();
        if (!mounted) return;
        setHealthStatus(data.status);
        setLatencyMs(typeof data.latencyMs === 'number' ? data.latencyMs : null);
        setRouterLabel(typeof data.routerLabel === 'string' ? data.routerLabel : '—');
        setRouterIsMock(data.isMock === true);
      } catch {
        if (!mounted) return;
        setHealthStatus('offline');
        setLatencyMs(null);
      }
    };
    check();
    const interval = setInterval(check, 20_000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  /* ---------- execution (unchanged wiring) ---------- */
  const handleSubmit = useCallback(async (goalOverride?: unknown) => {
    // CommandComposer wires this straight to onClick, so the first argument may
    // be a MouseEvent. Only a real string counts as an explicit goal.
    const explicit = typeof goalOverride === 'string' ? goalOverride : undefined;
    const goal = (explicit ?? input).trim();
    if (!goal || isRunning) return;

    const startTime = Date.now();
    startedAtRef.current = startTime;
    setLiveMs(0);

    setTask({
      taskId: '',
      goal,
      status: 'running',
      events: [],
      result: '',
      metrics: { ...EMPTY_METRICS },
      browser: { ...EMPTY_BROWSER, status: 'loading' },
    });
    setIsRunning(true);
    setInput('');
    setSheet('none');
    // Must clear: otherwise a stop during the new run targets the previous task id.
    taskIdRef.current = null;
    setVisualState({ agentState: 'observing' });

    abortControllerRef.current = new AbortController();

    try {
      const result = await streamAgentTask(
        goal,
        (event) => {
          setTask((prev) => {
            if (!prev) return null;

            if (event.type === 'event' && event.event) {
              const evt = event.event;
              const newEvents = [...prev.events, evt];

              let taskId = prev.taskId;
              if (!taskId && evt.taskId) {
                taskId = evt.taskId;
                taskIdRef.current = taskId;
              }

              let nextVisualState: AgentVisualState | null = null;
              if (evt.type === 'agent.observing') nextVisualState = 'observing';
              else if (evt.type === 'agent.planning') nextVisualState = 'planning';
              else if (evt.type === 'agent.action.started') nextVisualState = 'acting';
              else if (evt.type === 'router.retry' || evt.type === 'agent.recovery')
                nextVisualState = 'retrying';

              if (nextVisualState) {
                setVisualState({ agentState: nextVisualState, stepNumber: evt.stepNumber });
              }

              const browser = { ...prev.browser };
              if (evt.type === 'browser.initialized') browser.status = 'ready';
              if (evt.type === 'browser.state.changed') {
                if (evt.data?.url) browser.url = evt.data.url;
                if (evt.data?.title) browser.title = evt.data.title;
              }

              // A cancelled run ends with task.stopped instead of task.result.
              // Without this the UI stays stuck in the transitional "stopping" phase.
              if (evt.type === 'task.stopped') {
                setVisualState({ agentState: 'stopped' });
                return {
                  ...prev,
                  taskId,
                  events: newEvents,
                  browser,
                  status: 'stopped' as const,
                  result:
                    evt.data?.reason === 'user_cancelled'
                      ? 'Execution cancelled by operator.'
                      : 'Execution stopped.',
                  metrics: { ...prev.metrics, durationMs: Date.now() - startTime },
                };
              }

              return { ...prev, taskId, events: newEvents, browser };
            }

            if (event.type === 'result' && event.result) {
              const res = event.result;
              let status: 'completed' | 'failed' | 'stopped' = 'failed';
              if (res.status === 'success') status = 'completed';
              else if (res.status === 'stopped') status = 'stopped';

              setVisualState({
                agentState:
                  status === 'completed' ? 'completed' : status === 'stopped' ? 'stopped' : 'failed',
              });

              return {
                ...prev,
                taskId: res.taskId || prev.taskId,
                status,
                result: res.result,
                metrics: {
                  durationMs: Date.now() - startTime,
                  steps: res.steps || 0,
                  tokens: res.tokensUsed || 0,
                },
                capability: res.capability
                  ? {
                      selected: res.capability.selected,
                      reason: res.capability.reason,
                      browserFallbackUsed: res.capability.browserFallbackUsed,
                    }
                  : prev.capability,
                plan: (res as any).taskPlan
                  ? {
                      subgoals: (res as any).taskPlan.subgoals.map((s: any) => ({ id: s.id, description: s.description, type: s.type, status: s.status })),
                      replans: (res as any).replans ?? 0,
                      repairCalls: (res as any).repairPlannerCalls,
                    }
                  : prev.plan,
                goalAnalysis: (res as any).taskPlan
                  ? { compound: true, objectiveCount: (res as any).taskPlan.subgoals.length }
                  : prev.goalAnalysis,
                plannerCalls: res.plannerCalls ?? prev.plannerCalls,
                gmail: (res as any).gmail ?? prev.gmail,
                calendar: (res as any).calendar ?? prev.calendar,
                tasks: (res as any).tasks ?? prev.tasks,
                resolution: (res as any).resolution ?? prev.resolution,
                orchestration: (res as any).orchestration ?? prev.orchestration,
              };
            }

            if (event.type === 'error') {
              setVisualState({ agentState: 'failed' });
              return { ...prev, status: 'failed' as const, result: event.error || 'Unknown error' };
            }

            return prev;
          });
        },
        abortControllerRef.current.signal
      );

      if (result) {
        setTask((prev) => ({
          ...prev!,
          taskId: result.taskId,
          status: result.status === 'success' ? 'completed' : 'failed',
          result: result.result,
          metrics: {
            durationMs: Date.now() - startTime,
            steps: result.steps || 0,
            tokens: result.tokensUsed || 0,
          },
          browser: { ...prev!.browser, status: result.status === 'success' ? 'ready' : 'idle' },
          capability: result.capability
            ? {
                selected: result.capability.selected,
                reason: result.capability.reason,
                browserFallbackUsed: result.capability.browserFallbackUsed,
              }
            : prev!.capability,
          plan: (result as any).taskPlan
            ? {
                subgoals: (result as any).taskPlan.subgoals.map((s: any) => ({ id: s.id, description: s.description, type: s.type, status: s.status })),
                replans: (result as any).replans ?? 0,
                repairCalls: (result as any).repairPlannerCalls,
              }
            : prev!.plan,
          goalAnalysis: (result as any).taskPlan
            ? { compound: true, objectiveCount: (result as any).taskPlan.subgoals.length }
            : prev!.goalAnalysis,
          plannerCalls: result.plannerCalls ?? prev!.plannerCalls,
          gmail: (result as any).gmail ?? prev!.gmail,
          calendar: (result as any).calendar ?? prev!.calendar,
          tasks: (result as any).tasks ?? prev!.tasks,
          resolution: (result as any).resolution ?? prev!.resolution,
          orchestration: (result as any).orchestration ?? prev!.orchestration,
        }));
      }
    } catch (error) {
      if (error instanceof Error && error.name !== 'AbortError') {
        setTask((prev) => ({ ...prev!, status: 'failed', result: error.message }));
        setVisualState({ agentState: 'failed' });
      }
    } finally {
      setIsRunning(false);
      setLiveMs(null);
      abortControllerRef.current = null;
      // Execution already knows whether generation worked — don't make the user
      // wait up to 20s for the next poll to reflect a 429.
      void refreshHealth();
    }
  }, [input, isRunning, refreshHealth]);

  /* ---------- voice input ---------- */

  // Spoken and typed commands converge here: voice produces the same string a
  // human would type and goes through the identical submit path.
  const handleVoiceCommand = useCallback(
    (normalized: NormalizedCommand) => {
      setInput(normalized.command); // visible before it runs — never invisible execution
      void handleSubmit(normalized.command);
    },
    [handleSubmit]
  );

  const voice = useVoiceInput({
    enabled: booted === true,
    taskRunning: isRunning,
    onCommand: handleVoiceCommand,
  });

  // Enter on the boot screen is the activation gesture that unlocks the mic.
  const handleInitialize = useCallback(() => {
    window.sessionStorage.setItem('jarvisInitialized', 'true');
    setBooted(true);
    void voice.initialize();
  }, [voice]);

  const handleClear = useCallback(() => {
    setTask(null);
    setVisualState({ agentState: 'idle' });
    setLiveMs(null);
    setSheet('none');
  }, []);

  const handleStop = useCallback(async () => {
    if (!taskIdRef.current || !isRunning) return;
    setIsStopping(true);
    setVisualState({ agentState: 'stopping' });
    try {
      await fetch(`/api/agent/tasks/${taskIdRef.current}/stop`, { method: 'POST' });
    } catch (error) {
      console.error('Stop error:', error);
    } finally {
      setIsStopping(false);
    }
  }, [isRunning]);

  /* ---------- derived, real telemetry only ---------- */
  const phase = visualState.agentState;
  const tone = PHASE_TONE[phase];
  const events = task?.events ?? [];

  const tally = useMemo(() => {
    const count = (t: string) => events.filter((e) => e.type === t).length;
    return {
      retries: count('router.retry'),
      recoveries: count('agent.recovery'),
      failures: count('agent.action.failed'),
      observations: count('agent.observing'),
    };
  }, [events]);

  const currentStep = visualState.stepNumber ?? task?.metrics.steps ?? 0;

  // While running, the authoritative step count lives on the SSE events, not on
  // metrics (which the backend only fills in at task resolution).
  const displayMetrics = useMemo(() => {
    if (!task) return EMPTY_METRICS;
    if (!isRunning) return task.metrics;
    return { ...task.metrics, steps: Math.max(task.metrics.steps, currentStep) };
  }, [task, isRunning, currentStep]);

  const resolved = !!task && !isRunning && task.status !== 'running' && task.status !== 'idle';
  const showRails = bp === 'lg' || bp === 'xl';
  const isMobile = bp === 'sm';

  // Latest real event, used as the "current operation" readout.
  const latestEvent = events.length ? events[events.length - 1] : null;
  const currentOp = latestEvent ? (EVENT_LABEL[latestEvent.type] ?? latestEvent.type) : null;

  // Mobile drawers: the core stays visible until the operator opens one.
  const openSheet = () => {
    if (sheet === 'result') return <ResolvedBody task={task!} />;
    if (sheet === 'trace')
      return <ActivityTimeline events={events} isRunning={isRunning} showDevDetails={false} maxVisible={30} />;
    return <BrowserPanel browser={task?.browser || EMPTY_BROWSER} />;
  };

  return (
    <main className="relative h-[100dvh] w-screen overflow-hidden bg-[color:var(--j-void)]">
      {/* 3D environment — always the bottom layer, never unmounted */}
      <div className="absolute inset-0 z-0">
        <JarvisScene
          state={{ ...visualState, voice: voice.state }}
          quality={quality}
        />
      </div>

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[1]"
        style={{
          background:
            'radial-gradient(120% 80% at 50% 118%, rgba(46,230,255,0.10), transparent 60%), radial-gradient(80% 55% at 50% -12%, rgba(46,230,255,0.06), transparent 62%)',
        }}
      />

      {/* The operational HUD only exists after initialization. The 3D core
          renders throughout, so the boot overlay dissolves onto a live scene. */}
      {booted && (
      <div className={`pointer-events-none absolute inset-0 z-10 flex flex-col ${reducedMotion ? '' : 'j-hud-enter'}`}>
        {/* Unmissable when planner output is scripted rather than from an LLM. */}
        {routerIsMock && (
          <div
            className="pointer-events-auto flex shrink-0 items-center justify-center gap-2 px-3 py-1.5"
            role="status"
            style={{ background: 'rgba(255,176,32,0.16)', borderBottom: '1px solid rgba(255,176,32,0.5)' }}
          >
            <span className="j-label" style={{ color: 'var(--j-warn)', letterSpacing: '0.16em' }}>
              ⚠ {routerLabel} ACTIVE — planner output is scripted, not a real LLM
            </span>
          </div>
        )}
        {/* ===== top rail ===== */}
        <header className="pointer-events-auto flex shrink-0 items-center justify-between gap-2 overflow-hidden border-b border-[rgba(46,230,255,0.14)] bg-[rgba(4,7,13,0.55)] px-3 py-2.5 backdrop-blur-[2px] md:gap-4 md:px-6">
          <div className="flex items-center gap-3">
            <span className="relative flex h-7 w-7 items-center justify-center" aria-hidden="true">
              <span className="absolute inset-0 rounded-full border" style={{ borderColor: 'var(--j-accent-line)' }} />
              <span className="absolute inset-[5px] rounded-full border" style={{ borderColor: 'rgba(46,230,255,0.55)' }} />
              <span className="h-[5px] w-[5px] rounded-full" style={{ background: 'var(--j-accent)', boxShadow: '0 0 9px var(--j-accent)' }} />
            </span>
            <div className="leading-none">
              <h1 className="text-[15px] font-semibold tracking-[0.3em] text-[color:var(--j-ink)]" style={{ fontFamily: 'var(--j-mono)' }}>
                JARVIS
              </h1>
              <p className="j-label mt-[5px] hidden sm:block" style={{ fontSize: '8px' }}>
                Autonomous Web Agent
              </p>
            </div>
          </div>

          <div className="flex min-w-0 items-center gap-2 md:gap-5">
            {showRails && (
              <div className="flex flex-col items-end gap-[3px]">
                <span className="j-label" style={{ fontSize: '8.5px' }}>Phase</span>
                <StatusLed tone={tone} label={PHASE_LABEL[phase]} pulse={isRunning} />
              </div>
            )}
            {showRails && (
              <div className="flex flex-col items-end gap-[3px]">
                <span className="j-label" style={{ fontSize: '8.5px' }}>Router</span>
                <StatusLed tone={routerIsMock ? 'warn' : 'accent'} label={routerLabel} />
              </div>
            )}
            <ConnectionStatus status={healthStatus} isRunning={isRunning} latencyMs={latencyMs} />
            <VoiceIndicator
              state={voice.state}
              muted={voice.muted}
              onToggleMute={voice.toggleMute}
              compact={!showRails}
            />
            {showRails && (
              <>
                <span className="h-6 w-px bg-[rgba(46,230,255,0.16)]" aria-hidden="true" />
                <span className="j-num text-[11px] text-[color:var(--j-body)]">{clock}</span>
              </>
            )}
            <button
              type="button"
              onClick={() => setShowDevMode((v) => !v)}
              aria-pressed={showDevMode}
              className="j-clip px-2.5 py-1.5 text-[9.5px] font-semibold uppercase tracking-[0.16em] transition-colors"
              style={{
                border: `1px solid ${showDevMode ? 'var(--j-accent)' : 'rgba(46,230,255,0.3)'}`,
                color: showDevMode ? 'var(--j-accent)' : 'var(--j-mute)',
                background: showDevMode ? 'rgba(46,230,255,0.1)' : 'transparent',
                ['--j-cut' as string]: '5px',
              }}
            >
              Diag
            </button>
          </div>
        </header>

        {/* ===== instrument field ===== */}
        <div className="relative flex min-h-0 flex-1 gap-4 p-4 md:gap-5 md:p-5">
          {/* ---- left rail ---- */}
          {showRails && (
            <div className="pointer-events-auto flex w-[268px] shrink-0 flex-col gap-4 xl:w-[300px]">
              <HudPanel
                label="Agent Core"
                tone={tone}
                active={isRunning}
                status={<StatusLed tone={tone} label={PHASE_LABEL[phase]} pulse={isRunning} />}
              >
                <div className="space-y-2.5">
                  <div>
                    <div className="mb-1.5 flex items-baseline justify-between">
                      <span className="j-label">Step</span>
                      <span className="j-num text-[11px]" style={{ color: 'var(--j-accent)' }}>
                        {currentStep} / {MAX_STEPS}
                      </span>
                    </div>
                    <StepLadder current={currentStep} total={MAX_STEPS} />
                  </div>
                  <Readout label="Task ID" value={task?.taskId || '—'} title={task?.taskId} />
                  <Readout
                    label="Directive"
                    value={task?.goal || 'Awaiting directive'}
                    mono={false}
                    tone={task ? 'accent' : 'dormant'}
                    title={task?.goal}
                  />
                  <div className="grid grid-cols-2 gap-1.5 pt-0.5">
                    <CounterChip label="Observe" count={tally.observations} tone="accent" />
                    <CounterChip label="Retry" count={tally.retries} tone="warn" />
                    <CounterChip label="Recover" count={tally.recoveries} tone="warn" />
                    <CounterChip label="Faults" count={tally.failures} tone="bad" />
                  </div>
                </div>
              </HudPanel>

              <HudPanel
                label="Execution Trace"
                tone={tone}
                active={isRunning}
                status={<span className="j-num text-[10px] text-[color:var(--j-mute)]">{events.length} evt</span>}
                className="min-h-0 flex-1"
                bodyClassName="j-scroll max-h-full overflow-y-auto"
              >
                <ActivityTimeline events={events} isRunning={isRunning} showDevDetails={showDevMode} maxVisible={40} />
              </HudPanel>
            </div>
          )}

          {/* ---- centre: keep the core clear; only resolved output overlays ---- */}
          <div className="relative flex min-w-0 flex-1 items-end justify-center">
            {resolved && task && !isMobile && (
              <div className="j-enter pointer-events-auto absolute left-1/2 top-1/2 w-full max-w-[440px] -translate-x-1/2 -translate-y-1/2">
                <span
                  aria-hidden="true"
                  className="j-wave pointer-events-none absolute left-1/2 top-1/2 h-52 w-52 -translate-x-1/2 -translate-y-1/2 rounded-full border"
                  style={{ borderColor: resultColor(task.status) }}
                />
                <HudPanel
                  label={resultLabel(task.status)}
                  tone={resultTone(task.status)}
                  status={<span className="j-num text-[10px] text-[color:var(--j-mute)]">{task.taskId ? task.taskId.slice(0, 8) : '—'}</span>}
                >
                  <ResolvedBody task={task} />
                </HudPanel>
              </div>
            )}
          </div>

          {/* ---- right rail ---- */}
          {showRails && (
            <div className="pointer-events-auto flex w-[268px] shrink-0 flex-col gap-4 xl:w-[300px]">
              <HudPanel
                label="Browser Subsystem"
                tone={tone}
                active={isRunning && task?.browser.status === 'loading'}
                status={
                  <StatusLed
                    tone={task?.browser.status === 'ready' ? 'ok' : task?.browser.status === 'loading' ? 'warn' : 'dormant'}
                    label={task?.browser.status === 'ready' ? 'Live' : task?.browser.status === 'loading' ? 'Sync' : 'Down'}
                  />
                }
              >
                <BrowserPanel browser={task?.browser || EMPTY_BROWSER} />
              </HudPanel>

              <HudPanel label="Execution Metrics" tone={tone} active={isRunning}>
                <MetricsBar metrics={displayMetrics} liveMs={isRunning ? liveMs : null} />
              </HudPanel>

              {/* Fills the rail with real state — no invented telemetry. */}
              <HudPanel
                label="Current Operation"
                tone={tone}
                active={isRunning}
                className="min-h-0 flex-1"
                bodyClassName="j-scroll overflow-y-auto"
              >
                <div className="space-y-2.5">
                  <Readout
                    label="Operation"
                    value={currentOp ?? 'Standing by'}
                    mono={false}
                    tone={currentOp ? tone : 'dormant'}
                  />
                  {latestEvent?.stepNumber != null && (
                    <Readout label="On step" value={`S${latestEvent.stepNumber}`} tone={tone} />
                  )}
                  <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                    <Readout
                      label={`Router · ${routerLabel}`}
                      value={ROUTER_STATUS_TEXT[healthStatus] ?? healthStatus}
                      mono={false}
                      tone={
                        routerIsMock
                          ? 'warn'
                          : healthStatus === 'online'
                            ? 'ok'
                            : healthStatus === 'offline'
                              ? 'bad'
                              : healthStatus === 'checking'
                                ? 'dormant'
                                : 'warn'
                      }
                    />
                    <Readout label="Latency" value={latencyMs == null ? '—' : `${latencyMs} ms`}
                      tone={latencyMs == null ? 'dormant' : 'accent'} />
                  </div>
                  <Readout label="Session" value={clock} />
                </div>
              </HudPanel>

              {showDevMode && (
                <HudPanel label="Diagnostics" tone="accent" className="min-h-0 flex-1" bodyClassName="j-scroll max-h-full overflow-y-auto">
                  <DeveloperInspector task={task} routerLabel={routerLabel} />
                </HudPanel>
              )}
            </div>
          )}
        </div>

        {/* ===== mobile drawer ===== */}
        {isMobile && sheet !== 'none' && (
          <div className="pointer-events-auto j-enter shrink-0 px-4 pb-2">
            <HudPanel
              label={sheet === 'result' ? resultLabel(task?.status ?? 'idle') : sheet === 'trace' ? 'Execution Trace' : 'Browser Subsystem'}
              tone={sheet === 'result' ? resultTone(task?.status ?? 'idle') : tone}
              active={isRunning && sheet !== 'result'}
              status={
                <button
                  type="button"
                  onClick={() => setSheet('none')}
                  className="j-label px-1"
                  style={{ color: 'var(--j-accent)' }}
                  aria-label="Close panel"
                >
                  ✕ Close
                </button>
              }
              bodyClassName="j-scroll max-h-[34vh] overflow-y-auto"
            >
              {openSheet()}
            </HudPanel>
          </div>
        )}

        {/* ===== command deck ===== */}
        <div className="pointer-events-auto shrink-0 px-4 pb-4 md:px-5 md:pb-5">
          <div className="mx-auto w-full max-w-[720px]">
            <HudPanel
              label="Command Channel"
              tone={tone}
              active={isRunning}
              status={
                <span className="j-num text-[10px] text-[color:var(--j-mute)]">
                  {isRunning ? `T+${((liveMs ?? 0) / 1000).toFixed(1)}s` : 'READY'}
                </span>
              }
            >
              <VoiceTranscript
                interim={voice.interim}
                lastRaw={voice.lastRaw}
                lastCommand={voice.lastCommand}
                state={voice.state}
              />
              <CommandComposer
                value={input}
                onChange={setInput}
                onSubmit={handleSubmit}
                onClear={handleClear}
                onStop={handleStop}
                disabled={isRunning}
                showClear={!!task && !isRunning}
                isStopping={isStopping}
                phase={PHASE_LABEL[phase]}
              />

              {/* mobile: progressive disclosure instead of stacked panels */}
              {isMobile && (
                <div className="mt-2 flex items-center gap-1.5">
                  <SheetTab label={`Trace ${events.length ? `· ${events.length}` : ''}`} active={sheet === 'trace'}
                    onClick={() => setSheet(sheet === 'trace' ? 'none' : 'trace')} tone={tone} />
                  <SheetTab label="Browser" active={sheet === 'browser'}
                    onClick={() => setSheet(sheet === 'browser' ? 'none' : 'browser')} tone={tone} />
                  {resolved && task && (
                    <SheetTab label="Result" active={sheet === 'result'} tone={resultTone(task.status)}
                      onClick={() => setSheet(sheet === 'result' ? 'none' : 'result')} />
                  )}
                </div>
              )}
            </HudPanel>
          </div>
        </div>

        {/* ===== md: trace collapses under the deck ===== */}
        {bp === 'md' && (isRunning || events.length > 0) && (
          <div className="pointer-events-auto shrink-0 px-4 pb-4 md:px-5 md:pb-5">
            <div className="mx-auto w-full max-w-[720px]">
              <HudPanel
                label="Execution Trace"
                tone={tone}
                active={isRunning}
                status={<StatusLed tone={tone} label={PHASE_LABEL[phase]} pulse={isRunning} />}
                bodyClassName="j-scroll max-h-[22vh] overflow-y-auto"
              >
                <ActivityTimeline events={events} isRunning={isRunning} showDevDetails={false} maxVisible={25} />
              </HudPanel>
            </div>
          </div>
        )}
      </div>
      )}

      {/* Boot overlay sits above the scene but below nothing else. */}
      {booted === false && (
        <BootSequence onInitialize={handleInitialize} reducedMotion={reducedMotion} />
      )}
    </main>
  );
}

/* ---------- small presentational helpers ---------- */

function ResolvedBody({ task }: { task: TaskUiState }) {
  return (
    <div className="space-y-3">
      <ResultPanel status={task.status} result={task.result} />
      <div className="border-t pt-2.5" style={{ borderColor: 'rgba(46,230,255,0.14)' }}>
        <MetricsBar metrics={task.metrics} />
      </div>
    </div>
  );
}

function SheetTab({
  label,
  active,
  onClick,
  tone,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  tone: Tone;
}) {
  const c = active ? toneColor(tone) : 'var(--j-mute)';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={active}
      className="j-clip flex-1 px-2 py-2 text-[9.5px] font-semibold uppercase tracking-[0.14em] transition-colors"
      style={{
        border: `1px solid ${active ? toneColor(tone) : 'rgba(93,116,136,0.35)'}`,
        background: active ? `${toneColor(tone)}1a` : 'transparent',
        color: c,
        ['--j-cut' as string]: '5px',
      }}
    >
      {label}
    </button>
  );
}

function resultLabel(status: TaskUiState['status']) {
  return status === 'completed'
    ? 'Directive Resolved'
    : status === 'stopped'
      ? 'Execution Halted'
      : 'Execution Fault';
}

function resultTone(status: TaskUiState['status']): Tone {
  return status === 'completed' ? 'ok' : status === 'stopped' ? 'warn' : 'bad';
}

function resultColor(status: TaskUiState['status']) {
  return status === 'completed' ? 'var(--j-ok)' : status === 'stopped' ? 'var(--j-warn)' : 'var(--j-bad)';
}
