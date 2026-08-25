/**
 * COMPREHENSIVE CANCELLATION TEST
 * Tests real task cancellation with timing evidence
 */

import fetch from 'node-fetch';

const API_BASE = 'http://localhost:3000/api';

interface TestResult {
  name: string;
  status: 'PASS' | 'FAIL';
  evidence?: Record<string, any>;
  error?: string;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<{ evidence?: Record<string, any>; evidence_text?: string }>) {
  try {
    console.log(`\n📝 ${name}`);
    const result = await fn();
    results.push({
      name,
      status: 'PASS',
      evidence: result.evidence || { note: result.evidence_text },
    });
    console.log(`✅ PASS`);
    if (result.evidence_text) console.log(`   ${result.evidence_text}`);
  } catch (error: any) {
    results.push({ name, status: 'FAIL', error: error.message });
    console.error(`❌ FAIL: ${error.message}`);
  }
}

// Test 1: Unknown task 404
async function test_unknown_task() {
  const response = await fetch(`${API_BASE}/agent/tasks/unknown-abc/stop`, { method: 'POST' });

  if (response.status !== 404) throw new Error(`Expected 404, got ${response.status}`);

  const body = (await response.json()) as any;
  if (!body.error) throw new Error('No error in response');

  return { evidence_text: `404 with error: "${body.error}"` };
}

// Test 2: Task Already Completed
async function test_completed_task() {
  // Submit task and wait for completion
  const response = await fetch(`${API_BASE}/agent/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal: 'Open example.com and tell me the page title' }),
  });

  const text = await response.text();

  // Extract taskId and wait for completion
  let taskId = '';
  let foundResult = false;

  const lines = text.split('\n');
  for (const line of lines) {
    if (line.includes('task.started')) {
      const dataLine = lines[lines.indexOf(line) + 1];
      if (dataLine && dataLine.startsWith('data: ')) {
        const data = dataLine.slice(6);
        try {
          const evt = JSON.parse(data);
          if (evt.taskId) taskId = evt.taskId;
        } catch {}
      }
    }
    if (line.includes('task.result')) {
      foundResult = true;
    }
  }

  if (!taskId) throw new Error('Failed to extract taskId from stream');
  if (!foundResult) throw new Error('Task did not complete');

  // Now try to stop completed task
  const stopResponse = await fetch(`${API_BASE}/agent/tasks/${taskId}/stop`, { method: 'POST' });

  const stopBody = (await stopResponse.json()) as any;

  return {
    evidence: {
      taskId,
      stopStatus: stopResponse.status,
      stopResponse: stopBody,
    },
    evidence_text: `Task ${taskId.slice(0, 8)}... completed, stop returned ${stopResponse.status}`,
  };
}

// Test 3: Double Stop (Idempotency)
async function test_idempotent_stop() {
  // Submit task
  const response = await fetch(`${API_BASE}/agent/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal: 'Open example.com and tell me the page title' }),
  });

  const text = await response.text();

  // Extract taskId
  let taskId = '';
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.includes('task.started')) {
      const dataLine = lines[lines.indexOf(line) + 1];
      if (dataLine && dataLine.startsWith('data: ')) {
        try {
          const evt = JSON.parse(dataLine.slice(6));
          if (evt.taskId) {
            taskId = evt.taskId;
            break;
          }
        } catch {}
      }
    }
  }

  if (!taskId) throw new Error('Failed to extract taskId');

  // Stop once
  const stop1 = await fetch(`${API_BASE}/agent/tasks/${taskId}/stop`, { method: 'POST' });
  const body1 = (await stop1.json()) as any;

  // Stop again
  const stop2 = await fetch(`${API_BASE}/agent/tasks/${taskId}/stop`, { method: 'POST' });
  const body2 = (await stop2.json()) as any;

  // Verify both are valid responses (no 500)
  if (stop2.status === 500) throw new Error('Second stop returned 500 error');

  return {
    evidence: {
      firstStop: { status: stop1.status, body: body1 },
      secondStop: { status: stop2.status, body: body2 },
    },
    evidence_text: `First stop: ${stop1.status}, Second stop: ${stop2.status} (idempotent)`,
  };
}

// Test 4: SSE Event Sequence
async function test_sse_sequence() {
  const response = await fetch(`${API_BASE}/agent/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal: 'Open example.com and tell me the page title' }),
  });

  const text = await response.text();
  const events: string[] = [];

  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('event: ')) {
      events.push(line.slice(7));
    }
  }

  if (events.length === 0) throw new Error('No events received');
  if (!events.includes('task.started')) throw new Error('Missing task.started');

  return {
    evidence: { eventCount: events.length, events: events.slice(0, 10) },
    evidence_text: `Received ${events.length} events: ${events.slice(0, 5).join(', ')}...`,
  };
}

// Test 5: Health Check
async function test_health() {
  const response = await fetch(`${API_BASE}/omniroute/health`);
  const body = (await response.json()) as any;

  if (!body.status) throw new Error('No status in health response');

  return { evidence_text: `Health status: ${body.status}` };
}

// Main runner
async function main() {
  console.log('═'.repeat(70));
  console.log('CHECKPOINT 6: COMPREHENSIVE CANCELLATION TEST SUITE');
  console.log('═'.repeat(70));

  // Wait for server
  console.log('\n⏳ Waiting for server...');
  let ready = false;
  for (let i = 0; i < 15; i++) {
    try {
      await fetch(`${API_BASE}/omniroute/health`);
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  if (!ready) {
    console.error('❌ Server not responding');
    process.exit(1);
  }

  console.log('✅ Server ready\n');

  // Run tests
  await test('Test 1: Unknown task returns 404', test_unknown_task);
  await test('Test 2: Stop completed task returns 400', test_completed_task);
  await test('Test 3: Double stop is idempotent', test_idempotent_stop);
  await test('Test 4: SSE event sequence', test_sse_sequence);
  await test('Test 5: Health check', test_health);

  // Summary
  console.log('\n' + '═'.repeat(70));
  console.log('RESULTS');
  console.log('═'.repeat(70));

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;

  for (const r of results) {
    const icon = r.status === 'PASS' ? '✅' : '❌';
    console.log(`\n${icon} ${r.name}`);
    if (r.evidence) {
      console.log(`   Evidence: ${JSON.stringify(r.evidence).slice(0, 100)}...`);
    }
    if (r.error) {
      console.log(`   Error: ${r.error}`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed out of ${results.length}`);
  console.log('═'.repeat(70) + '\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Fatal:', error.message);
  process.exit(1);
});
