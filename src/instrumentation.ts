/**
 * Checkpoint 29 — Next.js App Router's own sanctioned "run once when a new
 * server instance starts" hook (see node_modules/next/dist/docs/01-app/
 * 03-api-reference/03-file-conventions/instrumentation.md — `register()`
 * is called once per real server instance and must complete before the
 * server accepts requests). Used here for exactly one thing: recovering
 * overdue reminders and arming the scheduler on startup (§9). Guarded to
 * the Node.js runtime only — the reminder store touches the filesystem
 * (fs), which the Edge runtime does not support.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { recoverOverdueRemindersOnStartup } = await import('@/core/reminders/startup');
    recoverOverdueRemindersOnStartup();
  }
}
