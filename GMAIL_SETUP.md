# Gmail Setup

JARVIS's Gmail capability (Checkpoint 17) uses proper OAuth 2.0 — never a stored
password, never a scraped login. To connect a real account, you need your own
Google Cloud OAuth client credentials.

## 1. Create a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and create a new project (or pick an existing one).
2. Go to **APIs & Services → Library**, search for **Gmail API**, and click **Enable**.

## 2. Configure the OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**.
2. Choose **External** (unless you have a Google Workspace org) and fill in the required fields (app name, your email).
3. Under **Scopes**, add:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.compose`
4. Under **Test users**, add the Gmail address you want JARVIS to access. While the app is in "Testing" mode, only test users can authorize it — this is intentional and fine for personal use; you do not need to submit for verification.

## 3. Create OAuth client credentials

1. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Under **Authorized redirect URIs**, add exactly:
   ```
   http://localhost:3000/api/auth/gmail/callback
   ```
4. Click **Create**. Copy the **Client ID** and **Client Secret**.

## 4. Configure JARVIS

Add to your `.env.local` (never commit this file):

```
GMAIL_CLIENT_ID=<your client id>
GMAIL_CLIENT_SECRET=<your client secret>
GMAIL_REDIRECT_URI=http://localhost:3000/api/auth/gmail/callback
```

## 5. Authorize

1. Start JARVIS (`npm run dev`).
2. Visit [http://localhost:3000/api/auth/gmail](http://localhost:3000/api/auth/gmail) in your browser.
3. Sign in with the Gmail account you added as a test user, and approve the requested scopes.
4. You'll land on a plain "Gmail connected" confirmation page. JARVIS can now search, read, summarize, draft, and — with your explicit confirmation each time — send mail through that account.

Tokens are stored locally at `.gmail-token.json` (already in `.gitignore`) and are never committed or sent anywhere except Google's own token endpoint.

## Local testing without a real account

Set `USE_MOCK_GMAIL=true` in `.env.local` to run against a deterministic, in-memory fixture mailbox — no Google Cloud project, no OAuth, no network calls. This is what JARVIS's own automated test suite uses. It's automatically refused when `NODE_ENV=production`.

## Scopes requested, and why

| Scope | Why |
|---|---|
| `gmail.readonly` | List, search, and read messages/threads — required for every READ/SEARCH/SUMMARIZE operation. Cannot send or modify anything. |
| `gmail.compose` | Create and send **drafts only** — required for DRAFT and the confirmed SEND step. This is narrower than `gmail.modify` or full mailbox access: it cannot delete a message, permanently trash anything, or bulk-relabel. |

No Drive, Contacts, or Calendar scope is requested.

## Revoking access

Visit [myaccount.google.com/permissions](https://myaccount.google.com/permissions), find the app, and remove access — then delete the local `.gmail-token.json` file.
