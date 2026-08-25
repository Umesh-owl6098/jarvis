/**
 * Deterministic voice tests.
 *
 * Normalisation is pure and tested directly. The listening loop is exercised
 * through the MockSpeechRecognition adapter, so transcript → normalisation →
 * submission is proven without a microphone or a speech service.
 *
 * These prove the PIPELINE. They do not prove that real speech is recognised
 * correctly — only a live microphone can do that.
 */

import { normalizeVoiceCommand } from '@/lib/voice/normalize';
import { MockSpeechRecognition } from '@/lib/voice/MockSpeechRecognition';
import type { SpeechAdapterHandlers } from '@/lib/voice/types';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++;
    console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/* ---------------- normalisation ---------------- */

function normalizationTests() {
  console.log('\n=== Transcript normalisation ===');

  const cases: { spoken: string; expect: string; note: string }[] = [
    { spoken: 'Jarvis, open amazon.com', expect: 'open amazon.com', note: 'A' },
    { spoken: 'Open wikipedia.org', expect: 'Open wikipedia.org', note: 'B (unchanged)' },
    { spoken: 'Hey Jarvis, open github.com', expect: 'open github.com', note: 'C' },
    {
      spoken: 'Jarvis, open wikipedia.org and search for OpenAI',
      expect: 'open wikipedia.org and search for OpenAI',
      note: 'D',
    },
    {
      spoken: 'Tell me about Jarvis architecture',
      expect: 'Tell me about Jarvis architecture',
      note: 'E (embedded Jarvis preserved)',
    },
    { spoken: 'Jarvis, amazon.com', expect: 'amazon.com', note: 'bare domain' },
    { spoken: 'jarvis open amazon dot com', expect: 'open amazon.com', note: 'spoken dot' },
    { spoken: 'Okay Jarvis: open github.com.', expect: 'open github.com', note: 'punctuation' },
  ];

  for (const c of cases) {
    const r = normalizeVoiceCommand(c.spoken);
    check(
      `${c.note}: "${c.spoken}"`,
      r.command === c.expect,
      `-> "${r.command}"${r.command === c.expect ? '' : ` (expected "${c.expect}")`}`
    );
  }

  check('F: empty transcript is not submittable', normalizeVoiceCommand('').submittable === false);
  check(
    'F: whitespace-only is not submittable',
    normalizeVoiceCommand('   ').submittable === false
  );
  check(
    'bare wake word alone is not submittable',
    normalizeVoiceCommand('Jarvis').submittable === false,
    `command="${normalizeVoiceCommand('Jarvis').command}"`
  );
  check(
    'command integrity: amazon.com never rewritten',
    normalizeVoiceCommand('Jarvis, open amazon.com').command === 'open amazon.com' &&
      !normalizeVoiceCommand('Jarvis, open amazon.com').command.includes('example.com')
  );
}

/* ---------------- listening loop via the mock adapter ---------------- */

/**
 * Minimal stand-in for the hook's handler wiring, so this runs in plain Node
 * without React. Mirrors useVoiceInput's decision rules.
 */
function makeLoop(adapter: MockSpeechRecognition) {
  const submitted: string[] = [];
  let state = 'idle';
  let paused = false;

  const handlers: SpeechAdapterHandlers = {
    // Guarded exactly as useVoiceInput does: a late speech-end event must not
    // clobber an already-accepted command.
    onSpeechStart: () => (state = state === 'listening' ? 'hearing' : state),
    onSpeechEnd: () => (state = state === 'hearing' ? 'processing' : state),
    onResult: (r) => {
      if (!r.isFinal) {
        state = 'hearing';
        return;
      }
      const n = normalizeVoiceCommand(r.transcript);
      if (!n.submittable) {
        state = 'listening';
        return;
      }
      state = 'accepted';
      adapter.stop(true); // suspend for the task
      paused = true;
      submitted.push(n.command);
    },
    onError: () => (state = 'error'),
    onEnd: () => {
      if (!paused) {
        state = 'listening';
        adapter.start(handlers);
      } else {
        state = 'paused';
      }
    },
  };

  return {
    submitted,
    get state() {
      return state;
    },
    start() {
      state = 'listening';
      adapter.start(handlers);
    },
    finishTask() {
      paused = false;
      state = 'listening';
      adapter.start(handlers);
    },
    handlers,
  };
}

function loopTests() {
  console.log('\n=== Listening loop (mock adapter) ===');

  {
    const adapter = new MockSpeechRecognition();
    const loop = makeLoop(adapter);
    loop.start();
    check('starts listening', loop.state === 'listening' && adapter.isRunning);

    adapter.speak('Jarvis, open amazon.com');
    check('final transcript submits normalised command', loop.submitted[0] === 'open amazon.com', loop.submitted[0]);
    check('recognition pauses for the task', adapter.isRunning === false && loop.state === 'accepted');

    loop.finishTask();
    check('returns to listening after task', loop.state === 'listening' && adapter.isRunning === true);
  }

  {
    // G: cancelled / silent session must not submit anything.
    const adapter = new MockSpeechRecognition();
    const loop = makeLoop(adapter);
    loop.start();
    adapter.finalize('');
    adapter.endSession();
    check('G: empty final transcript submits nothing', loop.submitted.length === 0);
    check('G: session restarts after a silent end', adapter.isRunning === true);
  }

  {
    // Chrome ends sessions unprompted; the loop must resume.
    const adapter = new MockSpeechRecognition();
    const loop = makeLoop(adapter);
    loop.start();
    const before = adapter.startLog.length;
    adapter.endSession();
    check(
      'auto-restart after engine ends the session',
      adapter.startLog.length === before + 1 && adapter.isRunning,
      `${before} -> ${adapter.startLog.length} sessions`
    );
  }

  {
    // Interim results must never submit.
    const adapter = new MockSpeechRecognition();
    const loop = makeLoop(adapter);
    loop.start();
    adapter.say('Jarvis, open amaz');
    check('interim transcript does not submit', loop.submitted.length === 0 && loop.state === 'hearing');
    adapter.finalize('Jarvis, open amazon.com');
    check('only the final transcript submits', loop.submitted.length === 1 && loop.submitted[0] === 'open amazon.com');
  }

  {
    // Mute stops capture; unmute resumes.
    const adapter = new MockSpeechRecognition();
    const loop = makeLoop(adapter);
    loop.start();
    adapter.stop(true); // mute
    check('mute stops recognition', adapter.isRunning === false);
    adapter.start(loop.handlers); // unmute
    check('unmute resumes recognition', adapter.isRunning === true);
  }

  {
    const adapter = new MockSpeechRecognition(false);
    let err = '';
    adapter.start({
      onResult: () => {},
      onEnd: () => {},
      onError: (e) => (err = e.code),
    });
    check('unsupported adapter reports not-supported', err === 'not-supported', err);
  }
}

normalizationTests();
loopTests();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
