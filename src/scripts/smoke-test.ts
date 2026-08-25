/**
 * Smoke Test: Verify Playwright browser control works correctly
 *
 * This test:
 * 1. Launches Chromium
 * 2. Navigates to example.com
 * 3. Reads page title and URL
 * 4. Extracts visible text
 * 5. Takes a screenshot
 * 6. Closes cleanly
 */

import { BrowserController } from '../core/browser/controller';
import path from 'path';
import { mkdirSync } from 'fs';

async function runSmokeTest() {
  const browser = new BrowserController();

  console.log('🧪 Starting Playwright Smoke Test...\n');

  try {
    // Step 1: Initialize browser
    console.log('📍 Step 1: Launching Chromium...');
    await browser.initialize();
    console.log('   ✅ Browser launched\n');

    // Step 2: Navigate to test website
    console.log('📍 Step 2: Navigating to https://example.com...');
    await browser.goto('https://example.com');
    console.log('   ✅ Navigation successful\n');

    // Step 3: Get page title
    console.log('📍 Step 3: Reading page title...');
    const title = await browser.getTitle();
    console.log(`   ✅ Page title: "${title}"\n`);

    // Step 4: Get current URL
    console.log('📍 Step 4: Getting current URL...');
    const url = await browser.getURL();
    console.log(`   ✅ Current URL: ${url}\n`);

    // Step 5: Extract visible text
    console.log('📍 Step 5: Extracting visible page text...');
    const visibleText = await browser.getVisibleText();
    const textPreview = visibleText.substring(0, 200);
    console.log(`   ✅ Text preview: "${textPreview}..."\n`);

    // Step 6: Take screenshot
    console.log('📍 Step 6: Taking screenshot...');
    const screenshotsDir = path.join(process.cwd(), '.test-artifacts');
    mkdirSync(screenshotsDir, { recursive: true });
    const screenshotPath = path.join(screenshotsDir, `smoke-test-${Date.now()}.png`);
    const actualPath = await browser.screenshot(screenshotPath);
    console.log(`   ✅ Screenshot saved: ${actualPath}\n`);

    // Summary
    console.log('━'.repeat(60));
    console.log('✅ SMOKE TEST PASSED');
    console.log('━'.repeat(60));
    console.log('\n📊 Test Results:');
    console.log(`   • Browser Launch: ✅`);
    console.log(`   • Navigation: ✅`);
    console.log(`   • Page Title: ✅ ("${title}")`);
    console.log(`   • Current URL: ✅ (${url})`);
    console.log(`   • Text Extraction: ✅ (${visibleText.length} chars)`);
    console.log(`   • Screenshot: ✅ (${actualPath})`);
    console.log(`   • Browser Close: ⏳ (in progress)\n`);

  } catch (error: any) {
    console.error('\n❌ SMOKE TEST FAILED');
    console.error(`Error: ${error.message}\n`);
    process.exit(1);
  } finally {
    console.log('📍 Closing browser...');
    await browser.close();
    console.log('   ✅ Browser closed cleanly\n');
  }
}

// Run the test
runSmokeTest().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
