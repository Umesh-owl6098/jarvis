/**
 * Checkpoint 17 — RealGmailClient: the googleapis-backed implementation of
 * GmailClient. Direct authorized Gmail API access — never Playwright/
 * browser automation of gmail.com, per §1's explicit instruction to prefer
 * a direct integration over browser scraping wherever one is available.
 */

import { gmail_v1, google, Auth } from 'googleapis';
import type { GmailClient, MailDraft, MailMessage, MailSearchResult, MailThread } from './types';

type OAuth2Client = Auth.OAuth2Client;

function headerValue(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function splitAddresses(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function base64UrlDecode(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf-8');
}

function base64UrlEncode(data: string): string {
  return Buffer.from(data, 'utf-8').toString('base64url');
}

/** Recursively finds the first text/plain part's body — Gmail messages are a MIME part tree, not a flat body. Falls back to text/html (stripped) only if no plain-text part exists anywhere. */
function extractPlainText(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return base64UrlDecode(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const found = extractPlainText(part);
      if (found) return found;
    }
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return base64UrlDecode(payload.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

function toMailMessage(msg: gmail_v1.Schema$Message): MailMessage {
  const headers = msg.payload?.headers;
  return {
    id: msg.id!,
    threadId: msg.threadId!,
    from: headerValue(headers, 'From'),
    to: splitAddresses(headerValue(headers, 'To')),
    cc: splitAddresses(headerValue(headers, 'Cc')) || undefined,
    subject: headerValue(headers, 'Subject'),
    date: headerValue(headers, 'Date'),
    snippet: msg.snippet ?? '',
    text: extractPlainText(msg.payload) || msg.snippet || '',
    labels: msg.labelIds ?? [],
  };
}

function buildRawMessage(to: string[], subject: string, body: string, cc?: string[]): string {
  const lines = [
    `To: ${to.join(', ')}`,
    ...(cc && cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
  ];
  return base64UrlEncode(lines.join('\r\n'));
}

// Checkpoint 25 fix — MODULE-level (not instance-level): gmail/resolve.ts's
// getGmailClient() deliberately constructs a FRESH RealGmailClient on every
// call (always reads the latest token from disk, so a re-authorization
// takes effect immediately without a server restart — unlike
// MockGmailClient, which IS a true singleton via mockSingleton and can
// safely own its own instance-level map). An instance-level `drafts` map
// would therefore be thrown away and rebuilt empty on every single call,
// contradicting this class's own documented "per process lifetime" cache
// — caught live via Checkpoint 25's real-backend draft-revision
// verification: updateDraft's caller (proposal-revision.ts) calls
// getDraft() to read the current recipient/subject before revising, and
// with a fresh empty map every time, it always came back null. Moving the
// cache to module scope keeps it genuinely process-lifetime, exactly as
// documented, without changing anything about how/when the OAuth2Client
// itself gets constructed or refreshed.
const realDraftsCache = new Map<string, MailDraft>();

/**
 * TEST-ONLY — direct read/write access to the module-level cache so its
 * lifecycle properties (survives fresh instance construction, isolated
 * from MockGmailClient, contains no OAuth data, etc.) can be verified
 * deterministically without a real network call to the Gmail API. Not
 * reachable from any user-facing command; only test files import these.
 * Mirrors pending-slot.ts's __setForTesting / conversation-context.ts's
 * __pushForTesting convention.
 */
export function __setRealDraftForTesting(draft: MailDraft): void {
  realDraftsCache.set(draft.draftId, draft);
}
export function __getRealDraftCacheSizeForTesting(): number {
  return realDraftsCache.size;
}
export function __clearRealDraftsCacheForTesting(): void {
  realDraftsCache.clear();
}

export class RealGmailClient implements GmailClient {
  readonly backend = 'real' as const;
  private gmail: gmail_v1.Gmail;
  private drafts = realDraftsCache;

  constructor(auth: OAuth2Client) {
    this.gmail = google.gmail({ version: 'v1', auth });
  }

  // §CP17.1 privacy fix — list/search fetch 'metadata' (headers + Gmail's
  // own short snippet), never the full body: MailMessage.text for these
  // results falls back to the snippet (see toMailMessage's `|| msg.snippet`),
  // the same short preview formatMessageLine() already displays. This isn't
  // just a display-layer filter — the full body is never pulled over the
  // wire or held in memory for a list/search result at all, so there's
  // nothing for a future code path, log line, or Developer Inspector to
  // accidentally surface. getMessage()/getThread() (the 'read'/'summarize'
  // operations, which the user explicitly asked for) still fetch 'full'.
  async listRecent(max: number, signal?: AbortSignal): Promise<MailMessage[]> {
    const list = await this.gmail.users.messages.list({ userId: 'me', maxResults: max }, { signal });
    return this.hydrate(list.data.messages ?? [], 'metadata', signal);
  }

  async search(query: string, max: number, signal?: AbortSignal): Promise<MailSearchResult> {
    const list = await this.gmail.users.messages.list({ userId: 'me', q: query, maxResults: max }, { signal });
    const messages = await this.hydrate(list.data.messages ?? [], 'metadata', signal);
    return { query, messages, resultSizeEstimate: list.data.resultSizeEstimate ?? messages.length };
  }

  private async hydrate(refs: gmail_v1.Schema$Message[], format: 'metadata' | 'full', signal?: AbortSignal): Promise<MailMessage[]> {
    const full = await Promise.all(
      refs
        .filter((r) => r.id)
        .map((r) => this.gmail.users.messages.get({ userId: 'me', id: r.id!, format }, { signal }))
    );
    return full.map((r) => toMailMessage(r.data));
  }

  async getMessage(id: string, signal?: AbortSignal): Promise<MailMessage | null> {
    try {
      const resp = await this.gmail.users.messages.get({ userId: 'me', id, format: 'full' }, { signal });
      return toMailMessage(resp.data);
    } catch {
      return null;
    }
  }

  async getThread(threadId: string, signal?: AbortSignal): Promise<MailThread | null> {
    try {
      const resp = await this.gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' }, { signal });
      const messages = (resp.data.messages ?? []).map(toMailMessage);
      if (messages.length === 0) return null;
      return { threadId, subject: messages[0].subject, messages };
    } catch {
      return null;
    }
  }

  async createDraft(to: string[], subject: string, body: string, cc?: string[], signal?: AbortSignal): Promise<MailDraft> {
    const raw = buildRawMessage(to, subject, body, cc);
    const resp = await this.gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } }, { signal });
    const draftId = resp.data.id!;
    const draft: MailDraft = { draftId, messageId: resp.data.message?.id ?? undefined, to, cc, subject, body, createdAt: Date.now(), sent: false };
    this.drafts.set(draftId, draft);
    return draft;
  }

  async updateDraft(draftId: string, to: string[], subject: string, body: string, cc?: string[], signal?: AbortSignal): Promise<MailDraft> {
    const cached = this.drafts.get(draftId);
    // §16-style idempotency guard, same reasoning as sendDraft's own — a
    // revision must never touch an already-sent draft (Gmail's own API
    // would reject this anyway once sent, but fail closed here first with
    // an honest message rather than an opaque API error).
    if (cached?.sent) {
      throw new Error('This draft has already been sent and can no longer be revised.');
    }
    const raw = buildRawMessage(to, subject, body, cc);
    const resp = await this.gmail.users.drafts.update({ userId: 'me', id: draftId, requestBody: { message: { raw } } }, { signal });
    const draft: MailDraft = { draftId, messageId: resp.data.message?.id ?? cached?.messageId, to, cc, subject, body, createdAt: cached?.createdAt ?? Date.now(), sent: false };
    this.drafts.set(draftId, draft);
    return draft;
  }

  async sendDraft(draftId: string, signal?: AbortSignal): Promise<{ messageId: string }> {
    const cached = this.drafts.get(draftId);
    // §16 — real-backend idempotency guard, independent of PendingActionStore.
    if (cached?.sent) {
      return { messageId: cached.sentMessageId! };
    }
    // §17 — signal is passed to the underlying HTTP call so an in-flight
    // send request can genuinely be aborted BEFORE Gmail accepts it; once
    // this call resolves successfully below, the send has already
    // happened and nothing after this point may report it as cancelled.
    const resp = await this.gmail.users.drafts.send({ userId: 'me', requestBody: { id: draftId } }, { signal });
    const messageId = resp.data.id!;
    if (cached) {
      cached.sent = true;
      cached.sentAt = Date.now();
      cached.sentMessageId = messageId;
    }
    return { messageId };
  }

  getDraft(draftId: string): MailDraft | null {
    return this.drafts.get(draftId) ?? null;
  }
}
