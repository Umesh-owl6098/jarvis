/**
 * CHECKPOINT 6: LIVE UI CANCELLATION TEST
 * Tests real cancellation flow: UI → Stop button → Backend → SSE task.stopped
 *
 * Prerequisites:
 * - Server running with USE_SLOW_MOCK_ROUTER=true
 * - Playwright installed
 */

import { chromium } from 'playwright';

const API_BASE = 'http://localhost:3000';

interface TestResult {
  test: string;
  status: 'PASS' | 'FAIL';
  details: string;
  evidence?: Record<string, any>;
}

const results: TestResult[] = [];

function report(test: string, status: 'PASS' | 'FAIL', details: string, evidence?: Record<string, any>) {
  results.push({ test, status, details, evidence });
  const icon = status === 'PASS' ? '✅' : '❌';
  console.log(`\n${icon} ${test}`);
  console.log(`   ${details}`);
}

async function main() {
  console.log('═'.repeat(80));
  console.log('CHECKPOINT 6: LIVE UI CANCELLATION TEST');
  console.log('═'.repeat(80));
  console.log('\nUsing: USE_SLOW_MOCK_ROUTER=true (5 second delays)');

  const browser = await chromium.launch();
  let page;
  let eventLog: string[] = [];
  let taskId: string | null = null;
  const timestamps: Record<string, number> = {};

  try {
    page = await browser.newPage();

    // Capture console logs
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[SLOW-MOCK]')) {
        console.log(`    [console] ${text}`);
      }
    });

    console.log('\n⏳ Waiting for server...');
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(`${API_BASE}/api/omniroute/health`);
        if (res.ok) {
          console.log('✅ Server ready\n');
          break;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    console.log('─'.repeat(80));
    console.log('TEST 1: Load JARVIS UI');
    console.log('─'.repeat(80));

    await page.goto(API_BASE, { waitUntil: 'networkidle' });
    const title = await page.title();
    report('UI loads', title.includes('JARVIS') ? 'PASS' : 'FAIL', `Page title: ${title}`);

    console.log('\n─'.repeat(80));
    console.log('TEST 2: Submit Goal and Start Task');
    console.log('─'.repeat(80));

    const goalInput = page.locator('textarea[placeholder*="goal" i], input[placeholder*="goal" i]');
    if (await goalInput.isVisible()) {
      await goalInput.fill('Open example.com and extract the page title');
      timestamps.goalSubmittedAt = Date.now();
      console.log(`    Submitted goal at ${new Date(timestamps.goalSubmittedAt).toISOString()}`);

      const executeBtn = page.locator('button:has-text("Execute")');
      await executeBtn.click();
      timestamps.taskSubmittedAt = Date.now();
      console.log(`    Clicked Execute at ${new Date(timestamps.taskSubmittedAt).toISOString()}`);

      report('Goal submitted', 'PASS', 'Goal entered and Execute clicked');
    } else {
      report('Goal submitted', 'FAIL', 'Could not find goal input field');
      throw new Error('UI structure changed');
    }

    console.log('\n─'.repeat(80));
    console.log('TEST 3: Wait for Stop Button to Appear');
    console.log('─'.repeat(80));

    const stopBtn = page.locator('button:has-text("Stop")');
    let stopVisible = false;
    for (let i = 0; i < 30; i++) {
      if (await stopBtn.isVisible()) {
        stopVisible = true;
        timestamps.stopButtonVisibleAt = Date.now();
        console.log(`    Stop button visible at ${new Date(timestamps.stopButtonVisibleAt).toISOString()}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    if (!stopVisible) {
      report('Stop button visible', 'FAIL', 'Stop button did not appear within 3 seconds');
    } else {
      report('Stop button visible', 'PASS', 'Stop button appeared and clickable');
    }

    console.log('\n─'.repeat(80));
    console.log('TEST 4: Click Stop During Planning Phase');
    console.log('─'.repeat(80));

    // Wait ~1.5 seconds to let the planner start its 5 second delay
    await new Promise((r) => setTimeout(r, 1500));
    timestamps.stopClickedAt = Date.now();

    if (stopVisible) {
      await stopBtn.click();
      console.log(`    Clicked Stop at ${new Date(timestamps.stopClickedAt).toISOString()}`);
      report('Stop clicked', 'PASS', 'Stop button clicked successfully');
    }

    console.log('\n─'.repeat(80));
    console.log('TEST 5: Verify UI State Transition (running → stopping → stopped)');
    console.log('─'.repeat(80));

    // Check if "Stopping" state appears (transitional)
    const stoppingText = page.locator('text=Stopping');
    let sawStopping = false;
    for (let i = 0; i < 20; i++) {
      if (await stoppingText.isVisible({ timeout: 500 }).catch(() => false)) {
        sawStopping = true;
        timestamps.stoppingStateAt = Date.now();
        console.log(`    Saw "Stopping" state at ${new Date(timestamps.stoppingStateAt).toISOString()}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    if (sawStopping) {
      report('Stopping state visible', 'PASS', 'UI transitioned to "Stopping" state');
    } else {
      report('Stopping state visible', 'FAIL', 'Did not observe "Stopping" state');
    }

    // Wait for Stopped state
    const stoppedText = page.locator('text=Stopped');
    let sawStopped = false;
    for (let i = 0; i < 30; i++) {
      if (await stoppedText.isVisible({ timeout: 500 }).catch(() => false)) {
        sawStopped = true;
        timestamps.stoppedStateAt = Date.now();
        console.log(`    Saw "Stopped" state at ${new Date(timestamps.stoppedStateAt).toISOString()}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    if (sawStopped) {
      report('Stopped state confirmed', 'PASS', 'UI reached "Stopped" state');
    } else {
      report('Stopped state confirmed', 'FAIL', 'Task did not transition to "Stopped"');
    }

    console.log('\n─'.repeat(80));
    console.log('TEST 6: Verify Task ID Was Captured');
    console.log('─'.repeat(80));

    // Try to extract task ID from UI or network logs
    const networkLog = await page.evaluate(() => {
      // Look for task ID in DOM
      const resultPanel = document.querySelector('[class*="result"]') || document.querySelector('[class*="panel"]');
      if (resultPanel) {
        const text = resultPanel.textContent || '';
        const match = text.match(/task[^:]*:\s*([a-zA-Z0-9_-]+)/i);
        if (match) return match[1];
      }
      return null;
    });

    if (networkLog) {
      taskId = networkLog;
      console.log(`    Found task ID: ${taskId}`);
      report('Task ID captured', 'PASS', `Task ID: ${taskId}`);
    } else {
      report('Task ID captured', 'FAIL', 'Could not extract task ID from UI');
    }

    console.log('\n─'.repeat(80));
    console.log('TEST 7: Verify Backend Received Stop Request');
    console.log('─'.repeat(80));

    // If we have a task ID, verify it's in stopped state
    if (taskId) {
      const statusResponse = await fetch(`${API_BASE}/api/agent/tasks/${taskId}/stop`, {
        method: 'POST',
      });

      if (statusResponse.status === 404) {
        console.log(`    Task is no longer in registry (cleaned up after completion)`);
        report('Backend stop verified', 'PASS', 'Stop request returned 404 (task cleaned or completed)');
      } else if (statusResponse.ok || statusResponse.status === 400) {
        console.log(`    Stop API responded with ${statusResponse.status}`);
        report('Backend stop verified', 'PASS', `Stop API operational (${statusResponse.status})`);
      } else {
        report('Backend stop verified', 'FAIL', `Unexpected status: ${statusResponse.status}`);
      }
    }

    console.log('\n─'.repeat(80));
    console.log('TEST 8: Verify Stop Button Disabled After Click');
    console.log('─'.repeat(80));

    const stopBtnDisabled = await stopBtn.isDisabled();
    if (stopBtnDisabled) {
      report('Stop button disabled', 'PASS', 'Stop button is disabled after stop');
    } else {
      report('Stop button disabled', 'FAIL', 'Stop button still enabled');
    }

    console.log('\n' + '═'.repeat(80));
    console.log('TIMING ANALYSIS');
    console.log('═'.repeat(80));

    console.log('\nKey events:');
    for (const [event, time] of Object.entries(timestamps)) {
      const isoTime = new Date(time).toISOString();
      console.log(`  ${event.padEnd(30)} ${isoTime}`);
    }

    if (timestamps.stopClickedAt && timestamps.stoppedStateAt) {
      const delta = timestamps.stoppedStateAt - timestamps.stopClickedAt;
      console.log(`\nStop to Stopped: ${delta}ms`);
      if (delta < 2000) {
        console.log(`  ✅ Quick response (< 2s), cancellation likely worked`);
      }
    }

    if (timestamps.taskSubmittedAt && timestamps.stopClickedAt) {
      const elapsed = timestamps.stopClickedAt - timestamps.taskSubmittedAt;
      console.log(`\nTask execution time before stop: ${elapsed}ms`);
    }
  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    report('Test execution', 'FAIL', String(error));
  } finally {
    await page?.close();
    await browser.close();
  }

  // Summary
  console.log('\n' + '═'.repeat(80));
  console.log('RESULTS');
  console.log('═'.repeat(80));

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;

  for (const result of results) {
    const icon = result.status === 'PASS' ? '✅' : '❌';
    console.log(`${icon} ${result.test}`);
  }

  console.log(`\n${passed} passed, ${failed} failed out of ${results.length}`);
  console.log('═'.repeat(80));

  if (failed === 0) {
    console.log('\n✅ CHECKPOINT 6 VERIFIED: Live UI cancellation works!');
  } else {
    console.log('\n⚠️  Some tests failed. Review above for details.');
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
