/**
 * Checkpoint 23 — PreferencesStore: a minimal local persistent store for
 * UserPreferences, backed by a single small JSON file. Not a database —
 * matches the same "single-user local app, one dev-server process" reasoning
 * already established for the OAuth token file (gmail/auth.ts's TOKEN_PATH)
 * and every Checkpoint 17-22 PendingAction/context store, but deliberately
 * kept as its OWN separate file: preferences and OAuth credentials must
 * never live in the same place (§3's explicit requirement) — different
 * lifecycle, different sensitivity, different reason to exist.
 *
 * session vs. preferences — the load-bearing distinction for this whole
 * checkpoint:
 *   - CP22 session context (conversation-context.ts / the PendingAction
 *     stores) is EPHEMERAL PER-TAB STATE, keyed by an opaque sessionId that
 *     is deliberately regenerated on every reload and wiped on every server
 *     restart. It answers "what did THIS conversation just say."
 *   - CP23 preferences are PERSISTENT LOCAL SINGLE-USER CONFIGURATION, never
 *     keyed by sessionId, surviving reloads AND server restarts by design.
 *     It answers "what does the operator of this one JARVIS installation
 *     always want," and nothing else. This is session isolation's opposite
 *     number, not an extension of it — CP23 does not add authentication or
 *     multi-user profiles; there is exactly one preference set because
 *     there is exactly one local operator, the same assumption the OAuth
 *     token file already makes.
 *
 * No in-memory cache is kept between calls — every read re-parses the file
 * from disk. For a file this small (three optional scalar fields) that
 * costs nothing, and it's what makes "a second store instance pointed at
 * the same path sees what the first wrote" (i.e. surviving a simulated
 * restart) true without any extra invalidation logic to get wrong.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { sanitizePreferences, type PreferenceField, type UserPreferences } from './types';

// Overridable via JARVIS_PREFERENCES_PATH so test scripts can point at a
// throwaway temp file — tests must NEVER write into the developer's real
// preference file. Deliberately resolved LAZILY (a function, read fresh on
// every access) rather than a top-level `const` computed once at module
// load: ES module `import` declarations are hoisted ahead of a script's own
// top-level statements, so a test file's own `process.env.JARVIS_...=`
// line — even textually placed before its `import`s — is NOT guaranteed to
// have run yet by the time this module's top level would otherwise
// evaluate. Reading the env var lazily, inside the getter below (called
// only once real work happens, well after the whole module graph AND the
// test file's own top-level code have finished), is what actually makes
// the override reliable — the same reason USE_MOCK_GMAIL and friends are
// read inside a function in resolve.ts, never captured into a top-level
// constant.
function defaultPath(): string {
  return process.env.JARVIS_PREFERENCES_PATH || path.join(process.cwd(), '.jarvis-preferences.json');
}

export class PreferencesStore {
  constructor(private readonly explicitPath?: string) {}

  private get filePath(): string {
    return this.explicitPath ?? defaultPath();
  }

  /**
   * Fail-safe load: a missing file is just "no preferences yet" (empty
   * object, not an error). A malformed/corrupted file (invalid JSON, not an
   * object, wrong-shaped fields) is NEVER allowed to throw or crash the
   * caller — sanitizePreferences() reduces anything unreadable to `{}`, the
   * same "nothing remembered" state as a fresh install. The bad file itself
   * is left untouched on disk (a read never rewrites it); only a later
   * explicit write replaces it.
   */
  private load(): UserPreferences {
    if (!existsSync(this.filePath)) return {};
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      return sanitizePreferences(raw);
    } catch {
      return {};
    }
  }

  /**
   * Atomic write: serialize to a uniquely-named temp file in the SAME
   * directory, then rename() over the real path. rename() on the same
   * filesystem is atomic — a reader can never observe a partially-written
   * file, and a crash mid-write leaves the OLD file intact (the temp file
   * is simply orphaned, never the real path in a half-written state).
   */
  private save(prefs: UserPreferences): void {
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmpPath = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(prefs, null, 2), { mode: 0o600 });
    try {
      renameSync(tmpPath, this.filePath);
    } catch (e) {
      try { unlinkSync(tmpPath); } catch {}
      throw e;
    }
  }

  getAll(): UserPreferences {
    return this.load();
  }

  get<K extends PreferenceField>(field: K): UserPreferences[K] {
    return this.load()[field];
  }

  set<K extends PreferenceField>(field: K, value: NonNullable<UserPreferences[K]>): UserPreferences {
    const next: UserPreferences = { ...this.load(), [field]: value };
    this.save(next);
    return next;
  }

  forget(field: PreferenceField): UserPreferences {
    const next = { ...this.load() };
    delete next[field];
    this.save(next);
    return next;
  }

  forgetAll(): UserPreferences {
    this.save({});
    return {};
  }
}

export const preferencesStore = new PreferencesStore();
