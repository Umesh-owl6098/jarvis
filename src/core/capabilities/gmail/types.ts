/**
 * Checkpoint 17 §5 — normalized Gmail types. Gmail API objects (their own
 * MIME-part tree, header arrays, base64url body encoding) never leak past
 * this boundary — everything downstream (capability router, task-manager,
 * Developer Inspector) sees only these flat shapes.
 */

export interface MailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  date: string;
  snippet: string;
  text: string;
  labels: string[];
}

export interface MailThread {
  threadId: string;
  subject: string;
  messages: MailMessage[];
}

export interface MailSearchResult {
  query: string;
  messages: MailMessage[];
  resultSizeEstimate: number;
}

export interface MailDraft {
  draftId: string;
  messageId?: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  createdAt: number;
  /** §16 — set once send() has actually been accepted by the backend; a second send() for the same draftId must short-circuit here, not fire twice. */
  sent: boolean;
  sentAt?: number;
  sentMessageId?: string;
}

/**
 * §4 — the controlled Gmail capability boundary. Both the real
 * (googleapis-backed) and mock implementations satisfy this exact contract,
 * so nothing downstream can tell which one is running except via
 * GmailClient.backend. Deliberately NO delete/trash/bulk-archive/
 * bulk-label/forward methods exist on this interface at all — those aren't
 * omissions to remember to guard against, they're simply not callable.
 */
export interface GmailClient {
  readonly backend: 'real' | 'mock';
  listRecent(max: number, signal?: AbortSignal): Promise<MailMessage[]>;
  search(query: string, max: number, signal?: AbortSignal): Promise<MailSearchResult>;
  getMessage(id: string, signal?: AbortSignal): Promise<MailMessage | null>;
  getThread(threadId: string, signal?: AbortSignal): Promise<MailThread | null>;
  createDraft(to: string[], subject: string, body: string, cc?: string[], signal?: AbortSignal): Promise<MailDraft>;
  /**
   * Checkpoint 22 — revises an EXISTING draft's content in place (Gmail's
   * own `drafts.update`), never creating a second draft. Only for content
   * the user themselves is revising conversationally ("make it shorter")
   * — this is still draft-only, exactly like createDraft: it can never
   * send anything, only sendDraft() can.
   */
  updateDraft(draftId: string, to: string[], subject: string, body: string, cc?: string[], signal?: AbortSignal): Promise<MailDraft>;
  /** Sends an EXISTING, already-created draft — there is no "compose and send in one call" on this interface, by design (§8: draft first, always). */
  sendDraft(draftId: string, signal?: AbortSignal): Promise<{ messageId: string }>;
  getDraft(draftId: string): MailDraft | null;
}
