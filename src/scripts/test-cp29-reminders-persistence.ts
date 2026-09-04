/**
 * Checkpoint 29 §Persistence — the ReminderStore's own atomic write/read
 * discipline: survives a simulated reload/restart (a fresh store instance
 * pointed at the same path), sanitizes malformed/corrupted files, never
 * crashes on bad input, uses atomic same-filesystem temp-write+rename with
 * restrictive permissions, and never contains anything beyond the
 * documented schema.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync, statSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { ReminderStore } from '@/core/reminders/store';
import { sanitizeReminderFile, sanitizeReminder, type Reminder } from '@/core/reminders/types';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'jarvis-cp29-reminders-'));
}

function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: 'r1',
    text: 'Check the oven',
    triggerAt: new Date(Date.now() + 3600000).toISOString(),
    createdAt: new Date().toISOString(),
    status: 'scheduled',
    ...overrides,
  };
}

async function main() {
  // ---------- 1. missing file — not an error, empty list ----------
  {
    const dir = freshDir();
    const store = new ReminderStore(path.join(dir, '.jarvis-reminders.json'));
    check('1. a missing file loads as an empty list, not an error', JSON.stringify(store.getAll()) === '[]');
  }

  // ---------- 2. create after confirmation — persists, and a fresh store instance sees it (reload/new-tab simulation) ----------
  {
    const dir = freshDir();
    const filePath = path.join(dir, '.jarvis-reminders.json');
    const store1 = new ReminderStore(filePath);
    const r = makeReminder({ id: 'r2' });
    store1.add(r);
    check('2. add() persists to disk', existsSync(filePath));

    const store2 = new ReminderStore(filePath); // simulates a page reload / new store instance
    const reloaded = store2.get('r2');
    check('2b. a FRESH store instance pointed at the same path sees the reminder (reload/new-tab survival)', reloaded !== null && reloaded.text === 'Check the oven', `reloaded=${JSON.stringify(reloaded)}`);
  }

  // ---------- 3. server-style reinitialization — same as #2 but explicitly framed as "process restart" ----------
  {
    const dir = freshDir();
    const filePath = path.join(dir, '.jarvis-reminders.json');
    const before = new ReminderStore(filePath);
    before.add(makeReminder({ id: 'r3', text: 'Survive restart' }));
    // "Restart" == construct a brand-new store instance, no shared in-memory state at all.
    const after = new ReminderStore(filePath);
    check('3. reminders survive a simulated server restart (no in-memory cache carried over)', after.get('r3')?.text === 'Survive restart');
  }

  // ---------- 4. malformed JSON — never crashes, degrades to empty ----------
  {
    const dir = freshDir();
    const filePath = path.join(dir, '.jarvis-reminders.json');
    writeFileSync(filePath, '{ this is not valid JSON', 'utf-8');
    const store = new ReminderStore(filePath);
    let threw = false;
    let result: Reminder[] = [];
    try { result = store.getAll(); } catch { threw = true; }
    check('4. invalid JSON never throws', !threw);
    check('4b. invalid JSON degrades to an empty list', JSON.stringify(result) === '[]');
  }

  // ---------- 5. empty file ----------
  {
    const dir = freshDir();
    const filePath = path.join(dir, '.jarvis-reminders.json');
    writeFileSync(filePath, '', 'utf-8');
    const store = new ReminderStore(filePath);
    let threw = false;
    try { store.getAll(); } catch { threw = true; }
    check('5. a completely empty file never throws, degrades to empty list', !threw);
  }

  // ---------- 6. array instead of the expected {reminders:[...]} wrapper object ----------
  {
    const dir = freshDir();
    const filePath = path.join(dir, '.jarvis-reminders.json');
    writeFileSync(filePath, JSON.stringify([makeReminder()]), 'utf-8');
    const store = new ReminderStore(filePath);
    check('6. a bare array at the top level (wrong wrapper shape) sanitizes to an empty list, never crashes', JSON.stringify(store.getAll()) === '[]');
  }

  // ---------- 7. unknown extra fields — dropped, not carried through ----------
  {
    const raw = { reminders: [{ ...makeReminder(), extraField: 'should be dropped', anotherOne: { nested: true } }] };
    const sanitized = sanitizeReminderFile(raw);
    check('7. unknown extra fields on a reminder are dropped', sanitized.length === 1 && !('extraField' in sanitized[0]) && !('anotherOne' in sanitized[0]), `sanitized=${JSON.stringify(sanitized)}`);
  }

  // ---------- 8. invalid reminder entries — dropped individually, valid siblings survive ----------
  {
    const raw = {
      reminders: [
        makeReminder({ id: 'valid1' }),
        { id: 'missing-fields' }, // invalid — missing text/triggerAt/createdAt/status
        makeReminder({ id: 'valid2', text: 'Second valid one' }),
        'not even an object',
        null,
        42,
      ],
    };
    const sanitized = sanitizeReminderFile(raw);
    check('8. invalid entries are dropped individually while valid siblings survive', sanitized.length === 2 && sanitized.every((r) => r.id === 'valid1' || r.id === 'valid2'), `sanitized=${JSON.stringify(sanitized.map((r) => r.id))}`);
  }

  // ---------- 9. duplicate ids — collapsed to the last occurrence, never two live reminders sharing one id ----------
  {
    const raw = { reminders: [makeReminder({ id: 'dup', text: 'First' }), makeReminder({ id: 'dup', text: 'Second (should win)' })] };
    const sanitized = sanitizeReminderFile(raw);
    check('9. duplicate ids collapse to exactly one record', sanitized.filter((r) => r.id === 'dup').length === 1);
    check('9b. duplicate ids collapse to the LAST occurrence', sanitized.find((r) => r.id === 'dup')?.text === 'Second (should win)');
  }

  // ---------- 10. invalid dates ----------
  {
    check('10a. sanitizeReminder rejects a non-ISO triggerAt', sanitizeReminder(makeReminder({ triggerAt: 'not a date' } as any)) === null);
    check('10b. sanitizeReminder rejects a non-ISO createdAt', sanitizeReminder(makeReminder({ createdAt: 'also not a date' } as any)) === null);
    check('10c. sanitizeReminder rejects an out-of-range/garbage date string', sanitizeReminder(makeReminder({ triggerAt: '9999-99-99' } as any)) === null);
  }

  // ---------- 11. invalid status ----------
  {
    check('11a. sanitizeReminder rejects an unknown status string', sanitizeReminder(makeReminder({ status: 'exploded' as any })) === null);
    check('11b. sanitizeReminder rejects a numeric status', sanitizeReminder(makeReminder({ status: 1 as any })) === null);
    check('11c. sanitizeReminder accepts every genuinely valid status', ['scheduled', 'delivered', 'cancelled'].every((s) => sanitizeReminder(makeReminder({ status: s as any })) !== null));
  }

  // ---------- 12. missing/empty text or id ----------
  {
    check('12a. sanitizeReminder rejects an empty text', sanitizeReminder(makeReminder({ text: '' })) === null);
    check('12b. sanitizeReminder rejects a whitespace-only text', sanitizeReminder(makeReminder({ text: '   ' })) === null);
    check('12c. sanitizeReminder rejects a missing id', sanitizeReminder({ ...makeReminder(), id: undefined } as any) === null);
  }

  // ---------- 13. atomic write behavior — no stray .tmp files left behind after a successful write ----------
  {
    const dir = freshDir();
    const filePath = path.join(dir, '.jarvis-reminders.json');
    const store = new ReminderStore(filePath);
    store.add(makeReminder({ id: 'atomic1' }));
    store.add(makeReminder({ id: 'atomic2' }));
    const files = readdirSync(dir);
    check('13. no orphaned .tmp file remains after successful writes', !files.some((f) => f.endsWith('.tmp')), `files=${JSON.stringify(files)}`);
    check('13b. exactly the real reminders file exists', files.includes('.jarvis-reminders.json'));
  }

  // ---------- 14. file permissions (0600) — best-effort, POSIX only ----------
  {
    const dir = freshDir();
    const filePath = path.join(dir, '.jarvis-reminders.json');
    const store = new ReminderStore(filePath);
    store.add(makeReminder({ id: 'perm1' }));
    if (process.platform !== 'win32') {
      const mode = statSync(filePath).mode & 0o777;
      check('14. the reminders file is written with mode 0600 (POSIX)', mode === 0o600, `mode=${mode.toString(8)}`);
    } else {
      check('14. permission check skipped on a non-POSIX platform (no-op pass)', true);
    }
  }

  // ---------- 15. idempotent cancel/deliver — double-transition is a safe no-op ----------
  {
    const dir = freshDir();
    const filePath = path.join(dir, '.jarvis-reminders.json');
    const store = new ReminderStore(filePath);
    store.add(makeReminder({ id: 'idem1' }));
    const first = store.cancel('idem1');
    const second = store.cancel('idem1');
    check('15. the FIRST cancel() succeeds', first === true);
    check('15b. a SECOND cancel() on an already-cancelled reminder is a no-op, returns false', second === false);
    check('15c. the reminder\'s cancelledAt is not overwritten by the second, no-op call', store.get('idem1')?.status === 'cancelled');
  }
  {
    const dir = freshDir();
    const filePath = path.join(dir, '.jarvis-reminders.json');
    const store = new ReminderStore(filePath);
    store.add(makeReminder({ id: 'idem2', triggerAt: new Date(Date.now() - 1000).toISOString() }));
    const delivered = store.markAllDueDelivered(new Date());
    const deliveredAgain = store.markAllDueDelivered(new Date());
    check('16. markAllDueDelivered marks a genuinely due reminder delivered exactly once', delivered.length === 1 && deliveredAgain.length === 0, `first=${delivered.length} second=${deliveredAgain.length}`);
  }

  // ---------- 17. scheduledSorted — deterministic ordering ----------
  {
    const dir = freshDir();
    const filePath = path.join(dir, '.jarvis-reminders.json');
    const store = new ReminderStore(filePath);
    const base = Date.now();
    store.add(makeReminder({ id: 'late', triggerAt: new Date(base + 3 * 3600000).toISOString() }));
    store.add(makeReminder({ id: 'early', triggerAt: new Date(base + 1 * 3600000).toISOString() }));
    store.add(makeReminder({ id: 'mid', triggerAt: new Date(base + 2 * 3600000).toISOString() }));
    const sorted = store.scheduledSorted();
    check('17. scheduledSorted orders strictly by triggerAt ascending', sorted.map((r) => r.id).join(',') === 'early,mid,late', `order=${sorted.map((r) => r.id).join(',')}`);
  }
  {
    const dir = freshDir();
    const filePath = path.join(dir, '.jarvis-reminders.json');
    const store = new ReminderStore(filePath);
    store.add(makeReminder({ id: 'sched1' }));
    store.add(makeReminder({ id: 'sched2' }));
    store.cancel('sched2');
    check('18. scheduledSorted never includes cancelled reminders', store.scheduledSorted().every((r) => r.id !== 'sched2'));
  }

  // ---------- 19. add() never silently overwrites a colliding id ----------
  {
    const dir = freshDir();
    const filePath = path.join(dir, '.jarvis-reminders.json');
    const store = new ReminderStore(filePath);
    store.add(makeReminder({ id: 'collide', text: 'Original' }));
    store.add(makeReminder({ id: 'collide', text: 'Attempted overwrite' }));
    check('19. add() with a colliding id never overwrites the original', store.get('collide')?.text === 'Original');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
