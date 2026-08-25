#!/usr/bin/env node
/**
 * Start JARVIS together with its planning service.
 *
 * JARVIS (localhost:3000) depends on OmniRoute (localhost:20128). Forgetting
 * the second one produces a red OFFLINE badge and planner failures that look
 * like application bugs, so this script makes the dependency explicit.
 *
 * It never spawns a duplicate: if something is already listening on the
 * OmniRoute port, it is reused as-is. OmniRoute is left running afterwards
 * (it is a daemon), so this only ever adds a process when one is missing.
 *
 * Development convenience only — nothing in production depends on it.
 */

import { spawn } from 'node:child_process';
import net from 'node:net';

const OMNIROUTE_PORT = Number(process.env.OMNIROUTE_PORT || 20128);
const OMNIROUTE_URL = process.env.OMNIROUTE_BASE_URL || `http://localhost:${OMNIROUTE_PORT}`;

/** Is anything accepting connections on the port? */
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Does it answer as OmniRoute, rather than merely holding the port? */
async function omnirouteResponds() {
  try {
    const res = await fetch(`${OMNIROUTE_URL}/v1/models`, {
      signal: AbortSignal.timeout(4000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureOmniRoute() {
  if (await omnirouteResponds()) {
    console.log(`✓ OmniRoute already serving on ${OMNIROUTE_URL} — reusing it`);
    return;
  }

  if (await portInUse(OMNIROUTE_PORT)) {
    console.error(
      `✗ Port ${OMNIROUTE_PORT} is occupied but does not answer as OmniRoute.\n` +
        `  Free it, or point JARVIS elsewhere with OMNIROUTE_BASE_URL.`
    );
    process.exit(1);
  }

  console.log(`… starting OmniRoute on port ${OMNIROUTE_PORT}`);
  const child = spawn(
    'npx',
    ['omniroute', 'serve', '--no-open', '--daemon', '--port', String(OMNIROUTE_PORT)],
    { stdio: 'inherit' }
  );
  await new Promise((resolve) => child.on('exit', resolve));

  // The daemon detaches, so poll until it actually answers.
  for (let i = 0; i < 30; i++) {
    if (await omnirouteResponds()) {
      console.log(`✓ OmniRoute ready on ${OMNIROUTE_URL}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.error(
    `✗ OmniRoute did not become ready on ${OMNIROUTE_URL}.\n` +
      `  Try it directly:  npx omniroute serve --no-open --log`
  );
  process.exit(1);
}

await ensureOmniRoute();

console.log('… starting JARVIS (next dev) on port 3000\n');
const next = spawn('npm', ['run', 'dev'], { stdio: 'inherit' });

// Only JARVIS is ours to stop; OmniRoute is a shared daemon and stays up.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    next.kill(sig);
    process.exit(0);
  });
}
next.on('exit', (code) => process.exit(code ?? 0));
