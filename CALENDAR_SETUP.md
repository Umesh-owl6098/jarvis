# Calendar Setup

JARVIS's Calendar capability (Checkpoint 18) reuses the exact same Google OAuth
client as Gmail (Checkpoint 17) — there is no separate app to create. If Gmail
is already connected, you only need to grant one additional consent for
Calendar scopes.

## 1. Enable the Calendar API

You already have a Google Cloud project from the Gmail setup ([GMAIL_SETUP.md](GMAIL_SETUP.md)).
In that same project:

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) → **APIs & Services → Library**.
2. Search for **Google Calendar API** and click **Enable**.

## 2. Add the Calendar scopes to your consent screen

1. Go to **APIs & Services → OAuth consent screen → Data Access** (or **Scopes**, depending on the console version).
2. Add:
   - `https://www.googleapis.com/auth/calendar.readonly`
   - `https://www.googleapis.com/auth/calendar.events`
3. No new OAuth client and no new redirect URI are needed — the same client ID/secret and the same `http://localhost:3000/api/auth/gmail/callback` redirect handle both Gmail and Calendar.

## 3. Authorize

1. Start JARVIS (`npm run dev`) — no new environment variables are needed; it reuses `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REDIRECT_URI` from your existing `.env.local`.
2. Visit [http://localhost:3000/api/auth/calendar](http://localhost:3000/api/auth/calendar) in your browser.
3. Approve the Calendar scopes on Google's consent screen. This is **incremental** authorization — it does not revoke or replace your existing Gmail access; the resulting token covers both.
4. You'll land on the same "Gmail connected" confirmation page (the callback is shared). JARVIS can now read your schedule, check availability, and — with your explicit confirmation each time — create, update, or cancel events.

## Local testing without a real account

Set `USE_MOCK_CALENDAR=true` in `.env.local` to run against a deterministic, in-memory fixture calendar — no Google Cloud project, no OAuth, no network calls. Automatically refused when `NODE_ENV=production`, same as `USE_MOCK_GMAIL`.

## Scopes requested, and why

| Scope | Why |
|---|---|
| `calendar.readonly` | List/search events, check free/busy — required for every READ/SEARCH/AVAILABILITY operation. Cannot create, modify, or delete anything. |
| `calendar.events` | Create/update/delete **events only** — required for the confirmed CREATE/UPDATE/CANCEL step. This is narrower than the full `calendar` scope: it cannot change calendar settings, sharing, or the list of calendars themselves. |

No broader Google account access is requested.

## Revoking access

Visit [myaccount.google.com/permissions](https://myaccount.google.com/permissions), find the app, and remove access — this revokes both Gmail and Calendar together (they share one token). Then delete the local `.gmail-token.json` file.
