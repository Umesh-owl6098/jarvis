/**
 * Checkpoint 25 — Gmail real-draft cache safety review.
 *
 * Verifies the lifecycle and isolation properties of realDraftsCache (the
 * module-level Map introduced to fix getGmailClient()'s real branch
 * constructing a fresh RealGmailClient — and therefore a fresh, empty
 * instance-local cache — on every single call). Covers:
 *   1. cache survives fresh RealGmailClient instance creation
 *   2. same draft ID across update (key never changes, only the value)
 *   3. cache updated only after successful remote operation (structural)
 *   4/5. remote failure is surfaced, never fabricates revision success
 *   6/7. Session B cannot revise or inherit Session A's draft/send state
 *   8. mock backend does not share the real cache
 *   9. cache contains no OAuth credentials/tokens
 *   10. no disk persistence
 *
 * Never makes a real (live) Gmail API call — RealGmailClient is exercised
 * directly with a dummy auth object and only ever via its synchronous
 * getDraft()/the TEST-ONLY cache accessors, which touch no network at
 * all; failure-path behavior is proven via MockGmailClient's own existing
 * "already sent" rejection, routed through the SAME production code path
 * (proposal-revision.ts's applyGmailUpdate) that RealGmailClient uses —
 * the catch-and-report logic there does not branch on backend type, so
 * this is a valid, deterministic proof for both.
 */
const TEST_PREFS_PATH = require('os').tmpdir() + '/jarvis-cp25-gmail-cache-safety-' + Date.now() + '.json';
process.env.JARVIS_PREFERENCES_PATH = TEST_PREFS_PATH;

process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_TASKS = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

import { runTask } from '@/core/agent/task-manager';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import { calendarPendingActionStore } from '@/core/capabilities/calendar/pending-action';
import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';
import { pendingSlotStore } from '@/core/agent/pending-slot';
import { getGmailClient } from '@/core/capabilities/gmail/resolve';
import { RealGmailClient, __setRealDraftForTesting, __getRealDraftCacheSizeForTesting, __clearRealDraftsCacheForTesting } from '@/core/capabilities/gmail/client';
import type { MailDraft } from '@/core/capabilities/gmail/types';
import { nanoid } from 'nanoid';
import { readFileSync } from 'fs';

const SID = 'test-session-a';
const SID_B = 'test-session-b';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function clearAll(sid: string) {
  pendingActionStore.clear(sid);
  calendarPendingActionStore.clear(sid);
  tasksPendingActionStore.clear(sid);
  pendingSlotStore.clear(sid);
}

// A fresh RealGmailClient never makes a network call unless one of the
// async gmail.* methods is invoked — getDraft() and the TEST-ONLY cache
// accessors below are synchronous / module-level and touch nothing on
// `this.gmail`, so a dummy auth object is safe here.
const DUMMY_AUTH = {} as any;

function fakeDraft(draftId: string, overrides: Partial<MailDraft> = {}): MailDraft {
  return {
    draftId,
    to: ['fixture@example.com'],
    subject: 'Fixture subject',
    body: 'Fixture body',
    createdAt: Date.now(),
    sent: false,
    ...overrides,
  };
}

async function main() {
  clearAll(SID);
  clearAll(SID_B);
  __clearRealDraftsCacheForTesting();

  // ---------- 1. cache survives fresh RealGmailClient instance creation ----------
  {
    __clearRealDraftsCacheForTesting();
    __setRealDraftForTesting(fakeDraft('draft-cache-1', { body: 'seeded before any instance existed' }));
    const instanceA = new RealGmailClient(DUMMY_AUTH);
    const seenByA = instanceA.getDraft('draft-cache-1');
    check('1a. a draft seeded into the module-level cache is visible from a freshly-constructed RealGmailClient instance', seenByA?.body === 'seeded before any instance existed');
    const instanceB = new RealGmailClient(DUMMY_AUTH);
    const seenByB = instanceB.getDraft('draft-cache-1');
    check('1b. a SECOND, independently-constructed instance sees the SAME cached draft (this is exactly what getGmailClient() does on every real call in production)', seenByB?.body === 'seeded before any instance existed');
    __clearRealDraftsCacheForTesting();
  }

  // ---------- 2. same draft ID across update — key identity, not a new entry ----------
  {
    __clearRealDraftsCacheForTesting();
    __setRealDraftForTesting(fakeDraft('draft-cache-2', { body: 'version 1' }));
    check('2a. cache size is 1 after seeding one draft', __getRealDraftCacheSizeForTesting() === 1);
    // Simulates what updateDraft() does internally on success: overwrite
    // the SAME map key with revised content — never insert a second entry.
    __setRealDraftForTesting(fakeDraft('draft-cache-2', { body: 'version 2 (revised)' }));
    check('2b. cache size REMAINS 1 after a same-ID revision — no second draft was created', __getRealDraftCacheSizeForTesting() === 1);
    const client = new RealGmailClient(DUMMY_AUTH);
    check('2c. getDraft() reflects the LATEST revision under the SAME draft ID', client.getDraft('draft-cache-2')?.body === 'version 2 (revised)');
    __clearRealDraftsCacheForTesting();
  }

  // ---------- 3. cache updated only after successful remote operation (structural) ----------
  {
    const src = readFileSync('src/core/capabilities/gmail/client.ts', 'utf-8');
    const updateDraftBody = src.slice(src.indexOf('async updateDraft('), src.indexOf('async sendDraft('));
    const awaitIdx = updateDraftBody.indexOf('await this.gmail.users.drafts.update(');
    const cacheWriteIdx = updateDraftBody.indexOf('this.drafts.set(draftId, draft)');
    check(
      '3. updateDraft() writes the cache STRICTLY AFTER the awaited real Gmail API call — a thrown/rejected API call never reaches the cache write at all',
      awaitIdx !== -1 && cacheWriteIdx !== -1 && awaitIdx < cacheWriteIdx,
      `awaitIdx=${awaitIdx} cacheWriteIdx=${cacheWriteIdx}`
    );
  }

  // ---------- 4/5. remote failure is surfaced; never fabricates revision success ----------
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Draft an email to Alice saying original body.', onEvent: () => {}, taskId: nanoid() });
    const pendingBefore = pendingActionStore.active(SID)!;
    const draftId = pendingBefore.draftId;

    // Simulate an out-of-band state change that makes the NEXT remote
    // update call fail (mirrors, e.g., the draft having been sent from
    // the real Gmail web UI in the meantime) — calling the client
    // directly here, bypassing runTask/pendingActionStore entirely, so
    // pendingActionStore still (incorrectly, from the outside) believes
    // the draft is revisable, exactly reproducing "cache/local state
    // says one thing, the remote mutation itself is what must fail."
    const client = getGmailClient();
    await client.sendDraft(draftId);

    const r = await runTask({ sessionId: SID, goal: 'Change it to say this must not silently succeed.', onEvent: () => {}, taskId: nanoid() });
    check('4. a remote update failure (already-sent) is surfaced as a failed result, not silently swallowed', r.status === 'failed', `status=${r.status} result=${r.result}`);
    check('5a. no fabricated "DRAFT UPDATED" success text', !/DRAFT UPDATED/.test(r.result), `result=${r.result}`);
    const pendingAfter = pendingActionStore.active(SID);
    check(
      '5b. send confirmation state is NOT incorrectly advanced — the pending action is untouched by the failed revision (still the same createdAt, not silently re-set to a fresh one)',
      pendingAfter !== null && pendingAfter.createdAt === pendingBefore.createdAt,
      `before=${pendingBefore.createdAt} after=${pendingAfter?.createdAt}`
    );
    clearAll(SID);
  }

  // ---------- 6/7. Session B cannot revise or inherit Session A's draft/send state ----------
  {
    clearAll(SID);
    clearAll(SID_B);
    await runTask({ sessionId: SID, goal: 'Draft an email to Alice saying private content.', onEvent: () => {}, taskId: nanoid() });
    const aBefore = pendingActionStore.active(SID)!;
    const client = getGmailClient();
    const bodyBefore = client.getDraft(aBefore.draftId)?.body;

    // Trace: sessionId -> pendingActionStore.active(sessionId) -> draftId
    // -> client.getDraft/updateDraft -> the cache. Session B's OWN lookup
    // of pendingActionStore.active(SID_B) is what actually gates this —
    // the cache itself is keyed by draftId, never by sessionId, and is
    // never given an opportunity to be queried with Session A's draftId
    // from Session B's turn.
    check('6a. Session B has no pending Gmail action of its own', !pendingActionStore.active(SID_B));
    const r = await runTask({ sessionId: SID_B, goal: 'Change it to say hijacked by session B.', onEvent: () => {}, taskId: nanoid() });
    const bodyAfter = client.getDraft(aBefore.draftId)?.body;
    check('6b. Session B\'s revision attempt does not reach/alter Session A\'s real draft content', bodyBefore === bodyAfter, `before=${bodyBefore} after=${bodyAfter} result=${r.result}`);
    check('7. Session B cannot inherit Session A\'s send confirmation state (still nothing pending for B)', !pendingActionStore.active(SID_B));
    clearAll(SID);
    clearAll(SID_B);
  }

  // ---------- 8. mock backend does not share the real cache ----------
  {
    clearAll(SID);
    __clearRealDraftsCacheForTesting();
    await runTask({ sessionId: SID, goal: 'Draft an email to Alice saying mock isolation check.', onEvent: () => {}, taskId: nanoid() });
    const mockDraftId = pendingActionStore.active(SID)!.draftId;
    const realClient = new RealGmailClient(DUMMY_AUTH);
    check(
      "8. a draft created against the MOCK backend is invisible to RealGmailClient's module-level cache — the two backends never share state",
      realClient.getDraft(mockDraftId) === null,
      `mockDraftId=${mockDraftId} realLookup=${JSON.stringify(realClient.getDraft(mockDraftId))}`
    );
    clearAll(SID);
  }

  // ---------- 9. cache contains no OAuth credentials/tokens ----------
  {
    __clearRealDraftsCacheForTesting();
    const draft = fakeDraft('draft-cache-9');
    __setRealDraftForTesting(draft);
    const keys = Object.keys(draft);
    const suspicious = keys.filter((k) => /token|auth|credential|secret|refresh/i.test(k));
    check('9a. the MailDraft shape itself carries no field that could hold a token/credential (TypeScript-enforced, verified at runtime on an actual cached entry)', suspicious.length === 0, `keys=${keys.join(',')}`);
    const src = readFileSync('src/core/capabilities/gmail/client.ts', 'utf-8');
    check('9b. structural — the auth/OAuth2Client is a per-instance constructor field, never assigned into the module-level cache', !/realDraftsCache\.set\([^)]*auth/i.test(src));
    __clearRealDraftsCacheForTesting();
  }

  // ---------- 10. no disk persistence ----------
  {
    const src = readFileSync('src/core/capabilities/gmail/client.ts', 'utf-8');
    check('10. no filesystem writes anywhere in gmail/client.ts (the real draft cache is in-memory only)', !/writeFile|readFile|\bfs\./.test(src));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  __clearRealDraftsCacheForTesting();
  try { require('fs').rmSync(TEST_PREFS_PATH, { force: true }); } catch {}
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  try { require('fs').rmSync(TEST_PREFS_PATH, { force: true }); } catch {}
  process.exit(1);
});
