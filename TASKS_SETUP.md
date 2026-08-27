# Tasks Setup

JARVIS's Tasks capability (Checkpoint 20) reuses the exact same Google OAuth
client as Gmail, Calendar, and Contacts — there is no separate app to
create, and no separate token file.

## 1. Enable the Google Tasks API

You already have a Google Cloud project from the earlier setups
([GMAIL_SETUP.md](GMAIL_SETUP.md), [CALENDAR_SETUP.md](CALENDAR_SETUP.md),
[CONTACTS_SETUP.md](CONTACTS_SETUP.md)). In that same project:

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) → **APIs & Services → Library**.
2. Search for **Google Tasks API** and click **Enable**.

This is a separate step from adding the scope below — Calendar and Contacts
both hit the same two-step requirement (scope consent and API enablement
are independent), so don't skip this even if the scope is already granted.

## 2. Add the Tasks scope to your consent screen

1. Go to **APIs & Services → OAuth consent screen → Data Access** (or **Scopes**, depending on the console version).
2. Add:
   - `https://www.googleapis.com/auth/tasks`
3. No new OAuth client and no new redirect URI are needed — the same client ID/secret and the same `http://localhost:3000/api/auth/gmail/callback` redirect handle Gmail, Calendar, Contacts, and Tasks together.

Google Tasks only offers two scopes: `tasks` (read/write) and
`tasks.readonly` (read-only). This checkpoint's create/update/complete/
delete operations need write access, so `tasks.readonly` alone isn't
enough — `tasks` is the narrowest scope that actually works here.

## 3. Authorize

1. Start JARVIS (`npm run dev`) — no new environment variables are needed; it reuses `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REDIRECT_URI` from your existing `.env.local`.
2. Visit [http://localhost:3000/api/auth/tasks](http://localhost:3000/api/auth/tasks) in your browser.
3. Approve the Tasks scope on Google's consent screen. This is **incremental** authorization — it does not revoke or replace your existing Gmail/Calendar/Contacts access; the resulting token covers all four.
4. You'll land on the same "Gmail connected" confirmation page (the callback is shared). JARVIS can now list, search, create, update, complete, and delete tasks — always with your explicit confirmation before any change.

## Local testing without a real account

Set `USE_MOCK_TASKS=true` in `.env.local` to run against a deterministic, in-memory fixture task list — no Google Cloud project, no OAuth, no network calls. Automatically refused when `NODE_ENV=production`, same as `USE_MOCK_GMAIL`/`USE_MOCK_CALENDAR`/`USE_MOCK_CONTACTS`.

## What JARVIS can and can't do with Tasks

- **Due dates are DATE-ONLY.** Google Tasks' `due` field records a calendar date, not a time of day — the time portion is discarded by the API itself. JARVIS never claims to set an alarm or a specific reminder time.
- **No push notifications.** Adding a task does not schedule a phone/email reminder — that's a separate Google Tasks app feature unrelated to this API. JARVIS will never say "I'll notify you at 3 PM."
- **No recurrence, no subtasks.** The Tasks API doesn't expose creating a recurring task or a subtask through the same `insert` call JARVIS uses (subtasks exist via a separate `move` operation this checkpoint doesn't implement). If you ask for either, JARVIS creates a single flat task and won't pretend otherwise.
- **No search endpoint.** The Tasks API has no full-text search — "find my report task" lists your tasks and matches by title locally, the same way both the mock and real backend behave here.
- **Every create/update/complete/delete requires your explicit confirmation** — JARVIS always shows a proposal first and waits for you to say "Create it." / "Update it." / "Mark it complete." / "Delete it." (or similar) before changing anything.

## Scope requested, and why

| Scope | Why |
|---|---|
| `tasks` | List/search/create/update/complete/delete tasks and task lists. Google Tasks has no narrower write scope — `tasks.readonly` cannot satisfy this checkpoint's mutation operations. |

No broader Google account access is requested.

## Revoking access

Visit [myaccount.google.com/permissions](https://myaccount.google.com/permissions), find the app, and remove access — this revokes Gmail, Calendar, Contacts, and Tasks together (they share one token). Then delete the local `.gmail-token.json` file.
