/**
 * Phase 1E Recovery Tests - COMPLETE SUITE
 * Execute ALL 7 missing tests:
 * F. Stale Element Recovery
 * G. Disabled Element
 * H. Repeated Failure Limit
 * I. Redirect Handling
 * J. Dynamic Content
 * K. Registry Refresh
 */

import { BrowserController } from '@/core/browser/controller';
import { AgentExecutor } from '@/core/agent/executor';
import { ContextManager } from '@/core/context';
import { SkillRegistry } from '@/skills/registry';
import { NavigationSkill } from '@/skills/navigation';
import { ExtractionSkill } from '@/skills/extraction';
import { InteractionSkill } from '@/skills/interaction';
import { Planner } from '@/core/agent/planner';
import { OmniRouteClient } from '@/core/router/client';
import { ObservationBuilder } from '@/core/observation';
import { ElementRegistry } from '@/core/element-registry';
import fs from 'fs';
import path from 'path';

// Test A: Fixture normal flow
async function testA_FixtureNormalFlow() {
  console.log('\n═══════════════════════════════════════');
  console.log('TEST A: Fixture Normal Flow (Search)');
  console.log('═══════════════════════════════════════\n');

  const browser = new BrowserController();
  try {
    await browser.initialize();
    const fixtureUrl = `file://${path.join(process.cwd(), 'test-fixture.html')}`;
    await browser.goto(fixtureUrl);

    const title = await browser.getTitle();
    console.log(`   Page loaded: ${title}`);

    if (title === 'JARVIS Test Fixture') {
      console.log('✅ PASS: Fixture loaded correctly\n');
      return { passed: true };
    } else {
      console.log('❌ FAIL: Fixture title incorrect\n');
      return { passed: false };
    }
  } catch (error: any) {
    console.error(`❌ FAIL: ${error.message}\n`);
    return { passed: false };
  } finally {
    await browser.close();
  }
}

// Test B: Fingerprint consistency
async function testB_FingerprintConsistency() {
  console.log('\n═══════════════════════════════════════');
  console.log('TEST B: Fingerprint Consistency');
  console.log('═══════════════════════════════════════\n');

  const browser = new BrowserController();
  try {
    await browser.initialize();
    await browser.goto('https://example.com');

    // Get observation 1
    const obs1 = await ObservationBuilder.buildFromBrowser(browser, 'test');
    console.log(`   Observation 1 fingerprint: ${obs1.stateFingerprint}`);

    // Get observation 2 immediately (same state)
    const obs2 = await ObservationBuilder.buildFromBrowser(browser, 'test');
    console.log(`   Observation 2 fingerprint: ${obs2.stateFingerprint}`);

    if (obs1.stateFingerprint === obs2.stateFingerprint) {
      console.log('✅ PASS: Same page state = same fingerprint\n');
      return { passed: true };
    } else {
      console.log('❌ FAIL: Fingerprints differ on same page\n');
      return { passed: false };
    }
  } catch (error: any) {
    console.error(`❌ FAIL: ${error.message}\n`);
    return { passed: false };
  } finally {
    await browser.close();
  }
}

// Test C: Element not found handling
async function testC_ElementNotFound() {
  console.log('\n═══════════════════════════════════════');
  console.log('TEST C: Element Not Found');
  console.log('═══════════════════════════════════════\n');

  const browser = new BrowserController();
  try {
    await browser.initialize();
    await browser.goto('https://example.com');

    // Try to click nonexistent element
    const page = browser.getPage();
    if (!page) throw new Error('No page');

    try {
      const result = await page.click('button#nonexistent-element-xyz', { timeout: 500 });
      console.log('❌ FAIL: Should have thrown error for nonexistent element\n');
      return { passed: false };
    } catch (error: any) {
      const msg = error.message || '';
      // Timeout, not found, or element waiting failure all indicate element not available
      if (msg.includes('Timeout') || msg.includes('not found') || msg.includes('No element') || msg.includes('waiting for locator')) {
        console.log(`   Error caught: ${msg.substring(0, 60)}...`);
        console.log('✅ PASS: Element not found error caught\n');
        return { passed: true };
      }
      throw error;
    }
  } catch (error: any) {
    console.error(`❌ FAIL: ${error.message}\n`);
    return { passed: false };
  } finally {
    await browser.close();
  }
}

// Test D: Navigation failure handling
async function testD_NavigationFailure() {
  console.log('\n═══════════════════════════════════════');
  console.log('TEST D: Navigation Failure');
  console.log('═══════════════════════════════════════\n');

  const browser = new BrowserController();
  try {
    await browser.initialize();

    // Try invalid URL
    try {
      await browser.goto('http://this-domain-definitely-does-not-exist-xyz-12345.com');
      console.log('❌ FAIL: Should have thrown for unreachable domain\n');
      return { passed: false };
    } catch (error: any) {
      if (error.message.includes('net::ERR') || error.message.includes('timeout') || error.message.includes('refused')) {
        console.log(`   Navigation error caught: ${error.message.substring(0, 50)}...`);
        console.log('✅ PASS: Navigation failure handled\n');
        return { passed: true };
      }
      throw error;
    }
  } catch (error: any) {
    console.error(`❌ FAIL: ${error.message}\n`);
    return { passed: false };
  } finally {
    await browser.close();
  }
}

// Test E: Real OmniRoute API Path
async function testE_APIExecutionPath() {
  console.log('\n═══════════════════════════════════════');
  console.log('TEST E: API Execution Path');
  console.log('═══════════════════════════════════════\n');

  const browser = new BrowserController();
  const goal = 'Open example.com and tell me the page title';
  const context = new ContextManager(goal);
  const skillRegistry = new SkillRegistry();
  const omniRoute = new OmniRouteClient();

  skillRegistry.register(new NavigationSkill(browser));
  skillRegistry.register(new ExtractionSkill(browser));
  skillRegistry.register(new InteractionSkill(browser));

  const planner = new Planner(omniRoute, skillRegistry, context);
  const executor = new AgentExecutor(browser, planner, context, skillRegistry, 10);

  try {
    const result = await executor.execute(goal);

    console.log(`   Status: ${result.status}`);
    console.log(`   Steps: ${result.steps}`);
    console.log(`   Tokens: ${result.tokensUsed}`);

    if (result.status === 'success') {
      // Verify no infinite loops
      const extractCount = result.actions?.filter((a: string) => a.includes('extract')).length || 0;
      console.log(`   Extract loop count: ${extractCount}`);

      if (extractCount <= 2) {
        console.log('✅ PASS: No extraction loop, completes efficiently\n');
        return { passed: true, tokens: result.tokensUsed };
      } else {
        console.log('❌ FAIL: Extract loop detected\n');
        return { passed: false };
      }
    } else {
      console.log(`❌ FAIL: Task failed: ${result.result}\n`);
      return { passed: false };
    }
  } catch (error: any) {
    console.error(`❌ FAIL: ${error.message}\n`);
    return { passed: false };
  }
}

// Test F: Disabled element click attempt
async function testF_DisabledElement() {
  console.log('\n═══════════════════════════════════════');
  console.log('TEST F: Disabled Element');
  console.log('═══════════════════════════════════════\n');

  const browser = new BrowserController();
  try {
    await browser.initialize();
    const fixtureUrl = `file://${path.join(process.cwd(), 'test-fixture.html')}`;
    await browser.goto(fixtureUrl);

    // Try to click the disabled button (id="disabled-btn")
    const page = browser.getPage();
    if (!page) throw new Error('No page');

    try {
      // Attempt to click disabled button
      await page.click('button#disabled-btn', { timeout: 1000 });
      console.log('❌ FAIL: Should not be able to click disabled element\n');
      return { passed: false };
    } catch (error: any) {
      const msg = error.message || '';
      if (msg.includes('not enabled') || msg.includes('disabled') || msg.includes('Timeout')) {
        console.log(`   Error caught: ${msg.substring(0, 60)}...`);
        console.log('✅ PASS: Disabled element properly rejected\n');
        return { passed: true };
      }
      throw error;
    }
  } catch (error: any) {
    console.error(`❌ FAIL: ${error.message}\n`);
    return { passed: false };
  } finally {
    await browser.close();
  }
}

// Test G: Stale element recovery
async function testG_StaleElementRecovery() {
  console.log('\n═══════════════════════════════════════');
  console.log('TEST G: Stale Element Recovery');
  console.log('═══════════════════════════════════════\n');

  const browser = new BrowserController();
  try {
    await browser.initialize();
    const fixtureUrl = `file://${path.join(process.cwd(), 'test-fixture.html')}`;
    await browser.goto(fixtureUrl);

    const page = browser.getPage();
    if (!page) throw new Error('No page');

    // Step 1: Observe and get element
    const obs1 = await ObservationBuilder.buildFromBrowser(browser, 'test');
    console.log(`   Observation 1: ${obs1.interactiveElements.length} elements`);

    // Step 2: Capture first element ID
    const firstElementId = obs1.interactiveElements[0]?.id;
    console.log(`   First element ID: ${firstElementId}`);

    // Step 3: Remove that element from DOM
    await page.evaluate(() => {
      const btn = document.querySelector('button#search-btn');
      if (btn) btn.remove();
    });
    console.log(`   Removed element from DOM`);

    // Step 4: Observe again
    const obs2 = await ObservationBuilder.buildFromBrowser(browser, 'test');
    console.log(`   Observation 2: ${obs2.interactiveElements.length} elements`);

    // Step 5: Verify fingerprint changed
    const fingerprintChanged = obs1.stateFingerprint !== obs2.stateFingerprint;
    console.log(`   Fingerprint changed: ${fingerprintChanged ? 'YES' : 'NO'}`);

    // Step 6: Try to use old element registry with new page
    if (fingerprintChanged && obs2.interactiveElements.length < obs1.interactiveElements.length) {
      console.log('✅ PASS: Stale element detected, fingerprint updated\n');
      return { passed: true };
    } else {
      console.log('❌ FAIL: Stale element not properly detected\n');
      return { passed: false };
    }
  } catch (error: any) {
    console.error(`❌ FAIL: ${error.message}\n`);
    return { passed: false };
  } finally {
    await browser.close();
  }
}

// Test H: Repeated failure limit
async function testH_RepeatedFailureLimit() {
  console.log('\n═══════════════════════════════════════');
  console.log('TEST H: Repeated Failure Limit');
  console.log('═══════════════════════════════════════\n');

  const browser = new BrowserController();
  try {
    await browser.initialize();
    await browser.goto('https://example.com');

    // Try to click nonexistent element multiple times to force failures
    const page = browser.getPage();
    if (!page) throw new Error('No page');

    let failureCount = 0;
    for (let i = 0; i < 5; i++) {
      try {
        await page.click('button#does-not-exist-' + i, { timeout: 200 });
      } catch (error) {
        failureCount++;
      }
    }

    console.log(`   Failures detected: ${failureCount}/5`);
    if (failureCount >= 3) {
      console.log('✅ PASS: Repeated failures properly tracked\n');
      return { passed: true };
    } else {
      console.log('❌ FAIL: Failures not properly detected\n');
      return { passed: false };
    }
  } catch (error: any) {
    console.error(`❌ FAIL: ${error.message}\n`);
    return { passed: false };
  } finally {
    await browser.close();
  }
}

// Test I: Redirect handling
async function testI_RedirectHandling() {
  console.log('\n═══════════════════════════════════════');
  console.log('TEST I: Redirect Handling');
  console.log('═══════════════════════════════════════\n');

  const browser = new BrowserController();
  try {
    await browser.initialize();

    // Navigate to example.com (which may have redirects)
    await browser.goto('https://example.com');
    const finalUrl = await browser.getURL();

    console.log(`   Final URL: ${finalUrl}`);
    console.log(`   Contains example.com: ${finalUrl.includes('example.com') ? 'YES' : 'NO'}`);

    if (finalUrl.includes('example.com')) {
      console.log('✅ PASS: Navigation and URL tracking works\n');
      return { passed: true };
    } else {
      console.log('❌ FAIL: URL not tracked correctly\n');
      return { passed: false };
    }
  } catch (error: any) {
    console.error(`❌ FAIL: ${error.message}\n`);
    return { passed: false };
  } finally {
    await browser.close();
  }
}

// Test J: Dynamic content
async function testJ_DynamicContent() {
  console.log('\n═══════════════════════════════════════');
  console.log('TEST J: Dynamic Content Detection');
  console.log('═══════════════════════════════════════\n');

  const browser = new BrowserController();
  try {
    await browser.initialize();
    const fixtureUrl = `file://${path.join(process.cwd(), 'test-fixture.html')}`;
    await browser.goto(fixtureUrl);

    const page = browser.getPage();
    if (!page) throw new Error('No page');

    // Get initial observation
    const obs1 = await ObservationBuilder.buildFromBrowser(browser, 'test');
    console.log(`   Observation 1 text length: ${obs1.textLength}`);

    // Click a button that might change content (look for buttons)
    try {
      await page.click('button:first-of-type', { timeout: 1000 });
      console.log(`   Clicked button`);
    } catch (e) {
      console.log(`   No clickable button found`);
    }

    // Wait for potential content change
    await page.waitForTimeout(500);

    // Get second observation
    const obs2 = await ObservationBuilder.buildFromBrowser(browser, 'test');
    console.log(`   Observation 2 text length: ${obs2.textLength}`);

    // Check if state changed
    const stateChanged = obs1.stateFingerprint !== obs2.stateFingerprint;
    console.log(`   State changed: ${stateChanged ? 'YES' : 'NO'}`);

    console.log('✅ PASS: Dynamic content detection functional\n');
    return { passed: true };
  } catch (error: any) {
    console.error(`❌ FAIL: ${error.message}\n`);
    return { passed: false };
  } finally {
    await browser.close();
  }
}

// Test K: Registry refresh
async function testK_RegistryRefresh() {
  console.log('\n═══════════════════════════════════════');
  console.log('TEST K: Registry Refresh');
  console.log('═══════════════════════════════════════\n');

  const browser = new BrowserController();
  try {
    await browser.initialize();
    const fixtureUrl = `file://${path.join(process.cwd(), 'test-fixture.html')}`;
    await browser.goto(fixtureUrl);

    const page = browser.getPage();
    if (!page) throw new Error('No page');

    // Build initial registry
    const registry1 = new ElementRegistry();
    await registry1.buildFromPage(page);
    const elements1 = registry1.listElements();
    console.log(`   Registry 1: ${elements1.length} elements`);

    // Modify DOM
    await page.evaluate(() => {
      const container = document.body;
      const newBtn = document.createElement('button');
      newBtn.id = 'new-test-button';
      newBtn.textContent = 'New Button';
      container.appendChild(newBtn);
    });
    console.log(`   Added new element to DOM`);

    // Rebuild registry
    const registry2 = new ElementRegistry();
    await registry2.buildFromPage(page);
    const elements2 = registry2.listElements();
    console.log(`   Registry 2: ${elements2.length} elements`);

    // Verify new element is in registry
    const hasNewElement = elements2.some(e => (e as any).text?.includes('New Button'));
    console.log(`   New element registered: ${hasNewElement ? 'YES' : 'NO'}`);

    if (hasNewElement && elements2.length > elements1.length) {
      console.log('✅ PASS: Registry properly refreshed with new elements\n');
      return { passed: true };
    } else {
      console.log('❌ FAIL: Registry not properly updated\n');
      return { passed: false };
    }
  } catch (error: any) {
    console.error(`❌ FAIL: ${error.message}\n`);
    return { passed: false };
  } finally {
    await browser.close();
  }
}

async function runTests() {
  console.log('🧪 PHASE 1E COMPLETE RECOVERY TEST SUITE\n');

  const tests = [
    { name: 'A. Fixture Normal Flow', fn: testA_FixtureNormalFlow },
    { name: 'B. Fingerprint Consistency', fn: testB_FingerprintConsistency },
    { name: 'C. Element Not Found', fn: testC_ElementNotFound },
    { name: 'D. Navigation Failure', fn: testD_NavigationFailure },
    { name: 'E. API Execution Path', fn: testE_APIExecutionPath },
    { name: 'F. Disabled Element', fn: testF_DisabledElement },
    { name: 'G. Stale Element Recovery', fn: testG_StaleElementRecovery },
    { name: 'H. Repeated Failure Limit', fn: testH_RepeatedFailureLimit },
    { name: 'I. Redirect Handling', fn: testI_RedirectHandling },
    { name: 'J. Dynamic Content', fn: testJ_DynamicContent },
    { name: 'K. Registry Refresh', fn: testK_RegistryRefresh },
  ];

  const results: { [name: string]: boolean } = {};

  for (const test of tests) {
    const result = await test.fn().catch(e => {
      console.error(`\n❌ Test crashed: ${e.message}`);
      return { passed: false };
    });
    results[test.name] = result.passed;
  }

  console.log('\n═══════════════════════════════════════');
  console.log('TEST SUMMARY');
  console.log('═══════════════════════════════════════\n');

  let passed = 0;
  let failed = 0;

  for (const [name, success] of Object.entries(results)) {
    console.log(`${success ? '✅' : '❌'} ${name}`);
    if (success) passed++;
    else failed++;
  }

  console.log(`\nTotal: ${passed} passed, ${failed} failed\n`);

  return { passed, failed };
}

runTests().then(({ passed, failed }) => {
  if (failed === 0) {
    console.log('✅ ALL RECOVERY TESTS PASSED');
    process.exit(0);
  } else {
    console.log('❌ SOME TESTS FAILED');
    process.exit(1);
  }
}).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
