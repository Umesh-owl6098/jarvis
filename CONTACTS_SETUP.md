# Contacts Setup

JARVIS's Contacts capability (Checkpoint 19) is **read-only** and reuses the
exact same Google OAuth client as Gmail and Calendar — there is no separate
app to create, and no separate token file. Contacts is not a standalone
feature you talk to directly; it exists only to resolve a name ("Alice",
"John Smith") into an email address for a Gmail draft or a Calendar
attendee. There is no capability to create, edit, or delete a contact.

## 1. Enable the People API

You already have a Google Cloud project from the Gmail/Calendar setup
([GMAIL_SETUP.md](GMAIL_SETUP.md), [CALENDAR_SETUP.md](CALENDAR_SETUP.md)).
In that same project:

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) → **APIs & Services → Library**.
2. Search for **Google People API** and click **Enable**.

This is a separate step from adding the scope below — Calendar hit the same
two-step requirement (scope consent and API enablement are independent), so
don't skip this even if the scope is already granted.

## 2. Add the Contacts scope to your consent screen

1. Go to **APIs & Services → OAuth consent screen → Data Access** (or **Scopes**, depending on the console version).
2. Add:
   - `https://www.googleapis.com/auth/contacts.readonly`
3. No new OAuth client and no new redirect URI are needed — the same client ID/secret and the same `http://localhost:3000/api/auth/gmail/callback` redirect handle Gmail, Calendar, and Contacts together.

## 3. Authorize

1. Start JARVIS (`npm run dev`) — no new environment variables are needed; it reuses `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REDIRECT_URI` from your existing `.env.local`.
2. Visit [http://localhost:3000/api/auth/contacts](http://localhost:3000/api/auth/contacts) in your browser.
3. Approve the Contacts scope on Google's consent screen. This is **incremental** authorization — it does not revoke or replace your existing Gmail/Calendar access; the resulting token covers all three.
4. You'll land on the same "Gmail connected" confirmation page (the callback is shared). JARVIS can now resolve a name you mention in a Gmail draft or Calendar event to a real contact's email — nothing else.

## Local testing without a real account

Set `USE_MOCK_CONTACTS=true` in `.env.local` to run against a deterministic, in-memory fixture address book — no Google Cloud project, no OAuth, no network calls. Automatically refused when `NODE_ENV=production`, same as `USE_MOCK_GMAIL`/`USE_MOCK_CALENDAR`.

## Scope requested, and why

| Scope | Why |
|---|---|
| `contacts.readonly` | Search contacts by name, retrieve display name/email addresses/organization — required to resolve "Alice" to an email address. Cannot create, edit, or delete a contact. |

No broader Google account access is requested. Only the fields needed for
resolution are fetched (`names`, `emailAddresses`, `organizations`) — no
addresses, birthdays, phone numbers, or photos.

## How resolution works

When a Gmail draft or Calendar event names someone without an explicit email
address, JARVIS searches your contacts for that name:

- **Exactly one match** → resolved automatically.
- **Multiple contacts match** (e.g. two people named "John Smith") → JARVIS asks which one, and does not draft or propose anything until you answer.
- **No match** → JARVIS asks for an explicit email address.
- **One contact, multiple email addresses** → JARVIS uses the address Google marks as primary, if any; otherwise it asks which address to use.

A contact's name or organization field is treated as plain data, never as an
instruction — it cannot authorize sending an email, creating an event, or
skipping the confirmation step that Gmail/Calendar already require.

## Revoking access

Visit [myaccount.google.com/permissions](https://myaccount.google.com/permissions), find the app, and remove access — this revokes Gmail, Calendar, and Contacts together (they share one token). Then delete the local `.gmail-token.json` file.
