/**
 * Verifies the deterministic half of the navigation path with no LLM involved:
 *
 *   bare domain → normalizeUrl → NavigationSkill → BrowserController → Playwright
 *
 * Proves that a user-typed domain reaches that domain (allowing for redirects),
 * and that nothing substitutes a different site.
 */

import { BrowserController } from '@/core/browser/controller';
import { NavigationSkill } from '@/skills/navigation';
import { normalizeUrl, sameSite } from '@/core/browser/url';
import type { NavigationEvidence } from '@/core/browser/navigation-evidence';

const CASES = ['amazon.com', 'wikipedia.org', 'github.com'];

async function main() {
  console.log('\n=== Domain navigation test (no LLM) ===\n');

  // normalization is pure — check it first
  for (const c of [
    'amazon.com',
    'www.amazon.com',
    'https://amazon.com',
    'HTTPS://Amazon.com/path?q=1',
  ]) {
    const n = normalizeUrl(c);
    console.log(`  normalize  ${c.padEnd(28)} -> ${n.url}${n.addedScheme ? '  (scheme added)' : ''}`);
  }
  for (const bad of ['javascript:alert(1)', 'not a url', 'file:///etc/passwd']) {
    try {
      normalizeUrl(bad);
      console.log(`  ❌ normalize accepted unsafe input: ${bad}`);
      process.exitCode = 1;
    } catch {
      console.log(`  rejected   ${bad}`);
    }
  }

  const browser = new BrowserController();
  await browser.initialize();
  const nav = new NavigationSkill(browser);
  let failures = 0;

  for (const domain of CASES) {
    console.log(`\n--- ${domain} ---`);
    const requested = normalizeUrl(domain).url;
    const out = await nav.execute({ url: domain });

    if (!out.success) {
      console.log(`  ❌ navigation failed: ${out.error}`);
      failures++;
      continue;
    }

    // Checkpoint 16: NavigationSkill.execute() now returns the full
    // NavigationEvidence structure (finalUrl/pageTitle/errorPageDetected/...)
    // in place of the old flat {url, title, redirected} shape — evidence.url
    // was never a real field, it just silently read as undefined before this
    // fix, which is why this script needed updating rather than the code.
    const { finalUrl, pageTitle: title, redirected, errorPageDetected } = out.result as NavigationEvidence;

    const onTarget = sameSite(requested, finalUrl);
    const leaked = /example\.com/i.test(finalUrl) || /Example Domain/i.test(title || '');

    console.log(`  requested : ${requested}`);
    console.log(`  final URL : ${finalUrl}`);
    console.log(`  title     : ${title}`);
    console.log(`  redirected: ${redirected}`);
    console.log(`  error page: ${errorPageDetected}`);
    console.log(`  same site : ${onTarget ? 'YES' : 'NO'}`);
    console.log(`  ${onTarget && !leaked && !errorPageDetected ? '✅ PASS' : '❌ FAIL'}${leaked ? ' (example.com leak!)' : ''}`);

    if (!onTarget || leaked || errorPageDetected) failures++;
  }

  await browser.close();
  console.log(`\n${failures === 0 ? '✅ ALL NAVIGATION CASES PASSED' : `❌ ${failures} case(s) failed`}\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
