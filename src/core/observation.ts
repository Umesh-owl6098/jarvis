import { z } from 'zod';

/**
 * PageObservation: Compact, structured observation of the current page state.
 * Designed to minimize tokens sent to LLM while retaining necessary information.
 *
 * Instead of sending entire HTML or screenshots, we send:
 * - URL and title
 * - Compact summary of visible text
 * - List of interactive elements with stable IDs
 * - Current task and recent actions
 *
 * This reduces token usage by 90%+ compared to full-page HTML or screenshots.
 */

export const InteractiveElementSchema = z.object({
  id: z.string(), // "e1", "e2" — resolvable via data-jarvis-id
  role: z.enum([
    'button', 'link', 'textbox', 'searchbox', 'textarea',
    'select', 'checkbox', 'radio', 'editable', 'other',
  ]),
  name: z.string().optional(),
  placeholder: z.string().optional(),
  type: z.string().optional(),
  disabled: z.boolean().optional(),
  checked: z.boolean().optional(),
  selected: z.string().optional(),
  inViewport: z.boolean().optional(),
});

export type InteractiveElement = z.infer<typeof InteractiveElementSchema>;

/**
 * A repeated content container (product card, search result, article, table
 * row) distinct from an InteractiveElement. Elements are what JARVIS can
 * click/type; content items are what it can understand/compare — e.g. a
 * product's name AND price AND link, mapped together, so the planner can
 * reason "lowest price = c4 -> click c4.linkedElementId" instead of
 * re-discovering that relationship from prose.
 */
export const ContentItemSchema = z.object({
  id: z.string(), // "c1", "c2" — distinct namespace from element ids
  type: z.enum(['product', 'result', 'article', 'listing', 'row', 'unknown']),
  title: z.string().optional(),
  price: z.string().optional(),
  numericPrice: z.number().optional(),
  currency: z.string().optional(),
  text: z.string().optional(),
  href: z.string().optional(),
  /** @deprecated kept as an alias of primaryActionElementId for compatibility. */
  linkedElementId: z.string().optional(),
  primaryActionElementId: z.string().optional(),
  secondaryActionElementIds: z.array(z.string()).optional(),
  actionRole: z.enum(['link', 'button', 'unknown']).optional(),
});

export type ContentItem = z.infer<typeof ContentItemSchema>;

export const PageObservationSchema = z.object({
  // Page metadata
  url: z.string(),
  title: z.string(),

  // Content summary (not full HTML)
  visibleTextSummary: z.string().describe('First 500 chars of visible text'),
  textLength: z.number().describe('Total characters visible on page'),

  // Interactive elements (visible + actionable, prioritised and capped)
  interactiveElements: z.array(InteractiveElementSchema),
  elementsTotalFound: z.number().default(0),
  elementsTruncated: z.boolean().default(false),

  // Structured content: relationships between nearby content (see ContentItemSchema).
  contentItems: z.array(ContentItemSchema).default([]),
  contentItemsTotalFound: z.number().default(0),
  contentItemsWithPrice: z.number().default(0),
  contentItemsTruncated: z.boolean().default(false),

  // Detected blockers (CAPTCHA / modal). Detection only — never bypassed.
  blockers: z.array(z.object({ kind: z.enum(['captcha', 'modal']), detail: z.string() })).default([]),
  openTabs: z.number().default(1),

  // Context for task continuity
  currentTask: z.string().describe('The goal the agent is trying to accomplish'),
  lastAction: z.string().optional().describe('What the agent just did'),
  lastActionResult: z.string().optional().describe('What happened after the action'),

  // Alerts and status
  alerts: z.array(z.string()).default([]).describe('Error/warning messages on page'),

  // State versioning for stale element detection
  stateFingerprint: z.string().describe('Lightweight hash of page state (URL + title + element names)'),

  // Timestamp for context management
  timestamp: z.number(),
});

export type PageObservation = z.infer<typeof PageObservationSchema>;

/**
 * ObservationBuilder: Constructs compact PageObservation from browser state.
 * Keeps extraction deterministic so we don't need to ask LLM.
 */
export class ObservationBuilder {
  /**
   * Generate a lightweight fingerprint of page state.
   * Used to detect when page has changed (stale elements).
   */
  private static generateFingerprint(
    url: string,
    title: string,
    elements: InteractiveElement[]
  ): string {
    const elementNames = elements.map(e => `${e.id}:${e.role}:${e.name || ''}`).join('|');
    const combined = `${url}||${title}||${elementNames}`;

    // Simple hash: just use first 50 chars + element count
    // This is intentionally lightweight for comparison purposes
    return `${combined.substring(0, 50)}#${elements.length}`;
  }

  static async buildFromBrowser(
    browser: any, // BrowserController
    currentTask: string,
    lastAction?: string,
    lastActionResult?: string,
  ): Promise<PageObservation> {
    const url = await browser.getURL();
    const title = await browser.getTitle();
    const visibleText = await browser.getVisibleText();

    // Visible, prioritised, capped registry snapshot (stamps data-jarvis-id)
    const snapshot = await browser.snapshotElements();
    const elements = snapshot.elements as InteractiveElement[];
    const contentItems = (snapshot.contentItems ?? []) as ContentItem[];
    const blockers = await browser.detectBlockers().catch(() => []);
    const openTabs = browser.listPages ? browser.listPages().length : 1;

    // Generate state fingerprint for stale element detection
    const stateFingerprint = this.generateFingerprint(url, title, elements);

    const observation: PageObservation = {
      url,
      title,
      visibleTextSummary: visibleText.substring(0, 500),
      textLength: visibleText.length,
      interactiveElements: elements,
      elementsTotalFound: snapshot.totalFound,
      elementsTruncated: snapshot.truncated,
      contentItems,
      contentItemsTotalFound: snapshot.contentItemsTotalFound ?? 0,
      contentItemsWithPrice: snapshot.contentItemsWithPrice ?? 0,
      contentItemsTruncated: snapshot.contentItemsTruncated ?? false,
      blockers,
      openTabs,
      currentTask,
      lastAction,
      lastActionResult,
      alerts: [], // Could be extracted from DOM if needed
      stateFingerprint,
      timestamp: Date.now(),
    };

    return observation;
  }

  /**
   * Format observation for sending to LLM.
   * Compact JSON representation.
   */
  static formatForLLM(obs: PageObservation): string {
    return JSON.stringify({
      url: obs.url,
      title: obs.title,
      textPreview: obs.visibleTextSummary,
      elements: obs.interactiveElements.map(e => {
        // Omit empty keys — they cost tokens on every element, every step.
        const rec: Record<string, unknown> = { id: e.id, role: e.role };
        if (e.name) rec.name = e.name;
        if (e.placeholder) rec.placeholder = e.placeholder;
        if (e.type) rec.type = e.type;
        if (e.disabled) rec.disabled = true;
        if (e.checked !== undefined) rec.checked = e.checked;
        if (e.selected) rec.selected = e.selected;
        return rec;
      }),
      elementsTruncated: obs.elementsTruncated || undefined,
      elementsTotal: obs.elementsTruncated ? obs.elementsTotalFound : undefined,
      contentItems: obs.contentItems?.length
        ? obs.contentItems.map(c => {
            const rec: Record<string, unknown> = { id: c.id, type: c.type };
            if (c.title) rec.title = c.title;
            if (c.price) rec.price = c.price;
            if (c.numericPrice !== undefined) rec.numericPrice = c.numericPrice;
            if (c.text && !c.price) rec.text = c.text;
            const actionId = c.primaryActionElementId || c.linkedElementId;
            if (actionId) rec.action = actionId;
            // href/actionRole intentionally omitted — see context.ts's
            // getContextForLLM for why (the actual live prompt path).
            return rec;
          })
        : undefined,
      contentItemsTruncated: obs.contentItemsTruncated || undefined,
      contentItemsTotal: obs.contentItemsTruncated ? obs.contentItemsTotalFound : undefined,
      blockers: obs.blockers?.length ? obs.blockers : undefined,
      openTabs: obs.openTabs && obs.openTabs > 1 ? obs.openTabs : undefined,
      task: obs.currentTask,
      lastAction: obs.lastAction,
      lastResult: obs.lastActionResult,
      alerts: obs.alerts?.length ? obs.alerts : undefined,
    });
  }
}
