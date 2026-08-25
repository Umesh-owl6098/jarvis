import type { Page } from 'playwright';

/**
 * ElementRegistry: builds a compact, deterministic index of the *visible,
 * actionable* elements on a page.
 *
 * Two problems this solves for real websites:
 *
 *  1. Token cost. A naive `querySelectorAll('button,a,input')` on a storefront
 *     returns many hundreds of nodes. We filter to visible + actionable,
 *     prioritise by interaction value, and hard-cap the result.
 *
 *  2. Addressability. The planner cannot reliably invent CSS selectors, so each
 *     captured element is tagged in the DOM with `data-jarvis-id`. Skills then
 *     act on `elementId` and resolve through that attribute, which is stable
 *     for the lifetime of a page state and rebuilt on every observation.
 */

export const JARVIS_ID_ATTR = 'data-jarvis-id';
/**
 * Which snapshot generation stamped an element. A fresh snapshot clears and
 * reassigns every id, so a HELD id from generation N can, in principle, be
 * reused for a *different* element in generation N+1 (ids are always e1..eN
 * sequentially). Checking this attribute before acting catches that case
 * instead of silently acting on the wrong element.
 */
export const JARVIS_GEN_ATTR = 'data-jarvis-gen';

export type ElementRole =
  | 'button'
  | 'link'
  | 'textbox'
  | 'searchbox'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'editable'
  | 'other';

export interface RegisteredElement {
  id: string;
  role: ElementRole;
  /** Accessible name, trimmed and length-capped. */
  name?: string;
  placeholder?: string;
  /** input[type], when meaningful. */
  type?: string;
  disabled?: boolean;
  checked?: boolean;
  selected?: string;
  /** True when the element is inside the current viewport. */
  inViewport?: boolean;
}

/**
 * A repeated content container (product card, search result, article,
 * table row, ...) distinct from an interactive element. JARVIS can
 * *understand/compare* these; `linkedElementId`, when present, is how it
 * *acts* on one — through the same interactive-element addressing, not a
 * new mechanism.
 */
export interface ContentItem {
  id: string; // "c1", "c2" — distinct namespace from element ids
  type: 'product' | 'result' | 'article' | 'listing' | 'row' | 'unknown';
  title?: string;
  price?: string;
  numericPrice?: number;
  currency?: string;
  /** Fallback summary when no price was found. */
  text?: string;
  href?: string;
  /**
   * Resolvable via the same `data-jarvis-id` mechanism as interactiveElements.
   * @deprecated kept as an alias of primaryActionElementId for compatibility.
   */
  linkedElementId?: string;
  /** The element to act on for this item — same value as linkedElementId. */
  primaryActionElementId?: string;
  /** Other plausible action targets within the same card (e.g. an image link and a title link). */
  secondaryActionElementIds?: string[];
  /** Tag-derived role of the primary action element, for fallback decisions. */
  actionRole?: 'link' | 'button' | 'unknown';
}

export interface RegistrySnapshot {
  elements: RegisteredElement[];
  /** How many actionable elements existed before the cap was applied. */
  totalFound: number;
  truncated: boolean;
  contentItems: ContentItem[];
  /** How many candidate containers existed before ranking/capping. */
  contentItemsTotalFound: number;
  contentItemsWithPrice: number;
  contentItemsTruncated: boolean;
  /** Generation number stamped on every element in this snapshot. */
  registryVersion: number;
}

export interface SnapshotOptions {
  /** Hard cap on returned elements. */
  max?: number;
  /** Cap on link elements specifically — real pages are mostly links. */
  maxLinks?: number;
  /** Hard cap on returned content items. */
  maxContentItems?: number;
  /** Generation number to stamp this snapshot's elements with. */
  version?: number;
}

const DEFAULTS = { max: 60, maxLinks: 25, maxContentItems: 12 };

/**
 * Collector source, kept as a STRING on purpose.
 *
 * Passing a function reference to page.evaluate() breaks under tsx/esbuild:
 * the `keepNames` transform wraps named inner helpers in `__name(...)`, which
 * does not exist in the browser context and throws
 * `ReferenceError: __name is not defined`. Evaluating source text sidesteps
 * the bundler entirely.
 */
const COLLECT_SRC = `function (args) {
  var attr = args.attr, genAttr = args.genAttr, version = args.version, max = args.max, maxLinks = args.maxLinks, maxContentItems = args.maxContentItems;
  var NAME_CAP = 80;

  function clean(s) {
    return (s || '').replace(/\\s+/g, ' ').trim().slice(0, NAME_CAP);
  }

  function isVisible(el) {
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity || '1') === 0) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;
    return true;
  }

  function accessibleName(el) {
    var aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;

    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var parts = labelledBy.split(/\\s+/).map(function (id) {
        var n = document.getElementById(id);
        return clean(n && n.textContent);
      }).filter(Boolean);
      if (parts.length) return clean(parts.join(' '));
    }

    if (el.labels && el.labels.length) {
      var lbl = clean(el.labels[0].textContent);
      if (lbl) return lbl;
    }

    var title = clean(el.getAttribute('title'));
    if (title) return title;

    var text = clean(el.textContent);
    if (text) return text;

    if (el.placeholder) return clean(el.placeholder);
    if (el.value) return clean(el.value);

    var img = el.querySelector('img[alt]');
    if (img) return clean(img.getAttribute('alt'));

    return clean(el.name);
  }

  function roleOf(el) {
    var tag = el.tagName.toLowerCase();
    var explicit = (el.getAttribute('role') || '').toLowerCase();

    if (tag === 'a') return el.href ? 'link' : 'other';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textarea';
    if (el.isContentEditable) return 'editable';

    if (tag === 'input') {
      var t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button' || t === 'image' || t === 'reset') return 'button';
      if (t === 'search') return 'searchbox';
      if (t === 'hidden') return 'other';
      return 'textbox';
    }

    if (explicit === 'button' || explicit === 'link' || explicit === 'checkbox') return explicit;
    if (explicit === 'searchbox' || explicit === 'textbox') return explicit;
    return 'other';
  }

  var SELECTOR = [
    'a[href]', 'button', 'input', 'textarea', 'select',
    '[contenteditable=""]', '[contenteditable="true"]',
    '[role="button"]', '[role="link"]', '[role="searchbox"]',
    '[role="textbox"]', '[role="checkbox"]'
  ].join(',');

  // Clear stamps from the previous snapshot so ids never collide across states.
  var stamped = document.querySelectorAll('[' + attr + ']');
  for (var s = 0; s < stamped.length; s++) { stamped[s].removeAttribute(attr); stamped[s].removeAttribute(genAttr); }

  // Utility/chrome links appear at the top of nearly every site and, in DOM
  // order, consume the entire link budget before any page content is reached.
  // They are almost never the target of a content task, so they rank last.
  var CHROME = /^(skip to|accessibility|sign ?in|log ?in|join us|help|find a store|store locator|my account|favou?rites|wish ?list|bag items|cart|checkout|home ?page|about us|careers|privacy|terms|cookie)/i;

  var vh = window.innerHeight || 0;
  var raw = [];
  var seen = [];

  var nodes = document.querySelectorAll(SELECTOR);
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (seen.indexOf(el) !== -1) continue;
    seen.push(el);

    var role = roleOf(el);
    if (role === 'other') continue;
    if (!isVisible(el)) continue;

    var rect = el.getBoundingClientRect();
    var inViewport = rect.top < vh && rect.bottom > 0;

    // Text entry is the highest-value target, then buttons, then links.
    var nm = accessibleName(el);
    var rank = (role === 'searchbox' || role === 'textbox' || role === 'textarea' || role === 'editable')
      ? 0
      : (role === 'button' || role === 'select' || role === 'checkbox' || role === 'radio') ? 1
      : (role === 'link' && CHROME.test(nm)) ? 3   // site chrome: last
      : 2;

    var rec = { role: role, name: nm };

    var placeholder = clean(el.placeholder);
    if (placeholder) rec.placeholder = placeholder;

    if (el.tagName.toLowerCase() === 'input') {
      var t2 = (el.type || 'text').toLowerCase();
      if (t2 !== 'text') rec.type = t2;
    }
    if (el.disabled) rec.disabled = true;
    if (role === 'checkbox' || role === 'radio') rec.checked = !!el.checked;
    if (role === 'select' && el.selectedOptions && el.selectedOptions[0]) {
      rec.selected = clean(el.selectedOptions[0].textContent);
    }
    if (inViewport) rec.inViewport = true;

    raw.push({ el: el, rec: rec, rank: rank, top: rect.top });
  }

  raw.sort(function (a, b) {
    if (a.rank !== b.rank) return a.rank - b.rank;
    var av = (a.top >= 0 && a.top < vh) ? 0 : 1;
    var bv = (b.top >= 0 && b.top < vh) ? 0 : 1;
    if (av !== bv) return av - bv;
    return a.top - b.top;
  });

  var totalFound = raw.length;
  var picked = [];
  var links = 0;
  for (var k = 0; k < raw.length; k++) {
    if (picked.length >= max) break;
    if (raw[k].rec.role === 'link') {
      if (links >= maxLinks) continue;
      links++;
    }
    picked.push(raw[k]);
  }

  var elements = [];
  for (var m = 0; m < picked.length; m++) {
    var id = 'e' + (m + 1);
    picked[m].el.setAttribute(attr, id);
    picked[m].el.setAttribute(genAttr, String(version));
    var out = { id: id };
    for (var key in picked[m].rec) out[key] = picked[m].rec[key];
    elements.push(out);
  }

  // -------------------------------------------------------------------
  // Structured content: relationships between nearby content (a product's
  // name AND price AND link, a search result's title AND snippet, a table
  // row's cells), which the interactive-element pass above cannot express
  // because it only sees isolated controls. Generic: no site adapters, no
  // "product" selectors — repeated container shape is the only signal.
  // -------------------------------------------------------------------

  var PRICE_RE = /(?:[$\\u20ac\\u00a3\\u00a5]\\s?\\d[\\d,]*(?:\\.\\d{1,2})?)|(?:\\d[\\d,]*(?:\\.\\d{1,2})?\\s?(?:USD|EUR|GBP))/;
  var CUR_SYMBOL = { '$': 'USD', '\\u20ac': 'EUR', '\\u00a3': 'GBP', '\\u00a5': 'JPY' };

  function parsePrice(s) {
    if (!s) return null;
    var m = PRICE_RE.exec(s);
    if (!m) return null;
    var raw = m[0];
    var numMatch = raw.match(/\\d[\\d,]*(?:\\.\\d{1,2})?/);
    if (!numMatch) return null;
    var num = parseFloat(numMatch[0].replace(/,/g, ''));
    if (isNaN(num)) return null;
    var currency;
    var symMatch = raw.match(/[$\\u20ac\\u00a3\\u00a5]/);
    if (symMatch) currency = CUR_SYMBOL[symMatch[0]];
    else {
      var codeMatch = raw.match(/USD|EUR|GBP/);
      if (codeMatch) currency = codeMatch[0];
    }
    return { display: raw.trim(), numeric: num, currency: currency };
  }

  function textOf(el) {
    return clean(el.innerText !== undefined ? el.innerText : el.textContent);
  }

  function primaryLink(container) {
    if (container.tagName && container.tagName.toLowerCase() === 'a' && container.href) return container;

    // Prefer the link with the most substantial accessible text, not just
    // the first in DOM order — an icon-only vote/bookmark/share link often
    // comes before the actual content link in markup (measured: Hacker
    // News's upvote arrow precedes the story title link in every row).
    var links = container.querySelectorAll('a[href]');
    var best = null;
    var bestLen = -1;
    for (var li = 0; li < links.length; li++) {
      var len = clean(links[li].textContent).length;
      if (len > bestLen) { bestLen = len; best = links[li]; }
    }
    if (best) return best;

    // Some "view" affordances are buttons rather than links (e.g. a card that
    // opens a detail panel via JS instead of navigating).
    return container.querySelector('button');
  }

  function actionRoleOf(el) {
    if (!el || !el.tagName) return 'unknown';
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    return 'unknown';
  }

  function titleOf(container, link) {
    var h = container.querySelector('h1,h2,h3,h4,h5,h6');
    if (h) { var t = clean(h.textContent); if (t) return t; }
    if (link) {
      var img = link.querySelector('img[alt]');
      if (img) { var alt = clean(img.getAttribute('alt')); if (alt) return alt; }
      var lt = clean(link.textContent);
      if (lt) return lt;
    }
    var full = textOf(container);
    return full ? full.slice(0, 80) : undefined;
  }

  // Walk up from a card-shaped link to find the nearest ancestor whose text
  // contains a price. Real markup nests price siblings at varying depths
  // (a card wrapper, not the anchor itself, usually holds both), so a fixed
  // "parent" assumption misses most ecommerce grids.
  function findPriceAncestor(el) {
    var node = el.parentElement;
    var depth = 0;
    while (node && depth < 4) {
      var t = textOf(node);
      if (t && PRICE_RE.test(t)) {
        var r = node.getBoundingClientRect();
        if (r.height > 0 && r.height < 800) return node;
      }
      node = node.parentElement;
      depth++;
    }
    return null;
  }

  var containerNodes = [];
  var seenContainers = [];
  function addContainer(el) {
    if (!el || seenContainers.indexOf(el) !== -1) return;
    seenContainers.push(el);
    containerNodes.push(el);
  }

  // Pass 1: semantic containers — list items, articles, table rows. Covers
  // most search-result / job-listing / article-list / table markup.
  var semanticNodes = document.querySelectorAll('li, article, [role="listitem"], [role="article"], tr');
  var semanticPriceCount = 0;
  for (var si = 0; si < semanticNodes.length && si < 600; si++) {
    var sEl = semanticNodes[si];
    if (!isVisible(sEl)) continue;
    var sRect = sEl.getBoundingClientRect();
    // Excludes true decorative/spacer rows (measured: HN's <tr class="spacer">
    // is 5px) without excluding real single-line compact rows — a dense
    // table/list UI can have legitimate content rows as short as ~16-19px
    // (measured on Hacker News's own story rows), which a taller threshold
    // silently drops entirely, leaving only outer table/list wrappers.
    if (sRect.height < 14) continue;
    if (PRICE_RE.test(textOf(sEl))) semanticPriceCount++;
    addContainer(sEl);
  }

  // Pass 2 (fallback): repeated card-shaped links grouped by parent-class
  // signature. Catches grids where the anchor IS the card and price lives
  // in a sibling outside it — no <li>/<article> wrapper at all. Gated on
  // priced results specifically, not just container count: a page can have
  // plenty of visible <li> (nav menus, footer chrome) while having zero
  // priced items among them, which raw container count would hide.
  if (containerNodes.length < 3 || semanticPriceCount < 3) {
    var anchorGroups = {};
    var anchors = document.querySelectorAll('a[href]');
    for (var ai = 0; ai < anchors.length && ai < 600; ai++) {
      var aEl = anchors[ai];
      if (!isVisible(aEl)) continue;
      // No size filter on the anchor itself — the anchor may be a small
      // text link inside a larger card. The real signal is a price found
      // in a nearby ancestor (see findPriceAncestor); that requirement,
      // plus the >=3 structural-repetition check below, is what excludes
      // one-off inline links.
      var host = findPriceAncestor(aEl);
      if (!host) continue;
      var sig = host.tagName + '.' + (host.className ? String(host.className).split(' ')[0] : '');
      if (!anchorGroups[sig]) anchorGroups[sig] = [];
      anchorGroups[sig].push({ host: host, link: aEl });
    }
    for (var sig2 in anchorGroups) {
      if (anchorGroups[sig2].length >= 3) {
        for (var gi = 0; gi < anchorGroups[sig2].length; gi++) addContainer(anchorGroups[sig2][gi].host);
      }
    }
  }

  // Drop containers that WRAP another candidate (keep the innermost).
  // A page built on nested tables/lists (e.g. an outer layout <tr> whose
  // single cell holds an entire inner <table> of real rows) matches the
  // same "tr"/"li" selector at every nesting level — the outer wrapper
  // .contains() every real row inside it. Keeping whichever candidate
  // contains no OTHER candidate keeps the actual leaf rows; the inverse
  // check (is this one contained BY another) keeps the outer wrapper
  // instead and drops all the real content, which is backwards.
  var finalContainers = [];
  for (var ci = 0; ci < containerNodes.length; ci++) {
    var cEl = containerNodes[ci];
    var isWrapper = false;
    for (var cj = 0; cj < containerNodes.length; cj++) {
      if (ci === cj) continue;
      if (containerNodes[cj] !== cEl && cEl.contains(containerNodes[cj])) { isWrapper = true; break; }
    }
    if (!isWrapper) finalContainers.push(cEl);
  }

  var contentCandidates = [];
  for (var fi = 0; fi < finalContainers.length && contentCandidates.length < 300; fi++) {
    var container = finalContainers[fi];
    var link = primaryLink(container);
    var fullText = textOf(container);
    if (!fullText && !link) continue;

    // Skip obvious nav/breadcrumb bars: "Home | About | Contact" (or the
    // slash-separated equivalent) is a near-universal site-chrome
    // convention — never a real story/product/article title — and the
    // <tr>/<li> semantic pass has no way to otherwise distinguish a site's
    // own header row from an actual content row. Generic across sites, not
    // tied to any one of them.
    var sepCount = (fullText.match(/\\s[|/]\\s/g) || []).length;
    if (sepCount >= 2) continue;

    var priceInfo = parsePrice(fullText);
    var title = titleOf(container, link);

    var tagLower = container.tagName.toLowerCase();
    var kind;
    if (tagLower === 'tr') kind = 'row';
    else if (priceInfo) kind = 'product';
    else if (tagLower === 'article' || container.getAttribute('role') === 'article') kind = 'article';
    else if (tagLower === 'li' || container.getAttribute('role') === 'listitem') kind = 'result';
    else kind = 'unknown';

    var item = { kind: kind, title: title };
    if (priceInfo) {
      item.price = priceInfo.display;
      item.numericPrice = priceInfo.numeric;
      if (priceInfo.currency) item.currency = priceInfo.currency;
    } else if (fullText) {
      item.text = fullText.slice(0, 140);
    }
    if (link && link.getAttribute('href')) item.href = link.getAttribute('href');
    item._linkEl = link;
    item._actionRole = actionRoleOf(link);
    // Other already-registered interactive elements inside the same card
    // (e.g. a separate "wishlist" button alongside the title link) — kept as
    // fallback targets, not clicked automatically.
    item._secondaryEls = [];
    for (var pi2 = 0; pi2 < picked.length && item._secondaryEls.length < 2; pi2++) {
      var candEl = picked[pi2].el;
      if (candEl !== link && container.contains(candEl)) item._secondaryEls.push(candEl);
    }
    item._top = container.getBoundingClientRect().top;
    contentCandidates.push(item);
  }

  var contentItemsTotalFound = contentCandidates.length;
  var withPrice = [];
  var withoutPrice = [];
  for (var wc = 0; wc < contentCandidates.length; wc++) {
    if (contentCandidates[wc].numericPrice !== undefined) withPrice.push(contentCandidates[wc]);
    else withoutPrice.push(contentCandidates[wc]);
  }
  // Deterministic local ranking (no LLM call): cheapest first. This is the
  // ordering "least/most costly" tasks need, and it costs nothing extra —
  // the numeric prices are already in hand from the pass above.
  withPrice.sort(function (a, b) { return a.numericPrice - b.numericPrice; });
  withoutPrice.sort(function (a, b) { return a._top - b._top; });

  var chosen = [];
  for (var pi = 0; pi < withPrice.length && chosen.length < maxContentItems; pi++) chosen.push(withPrice[pi]);
  for (var wi = 0; wi < withoutPrice.length && chosen.length < maxContentItems; wi++) chosen.push(withoutPrice[wi]);

  var contentItems = [];
  var nextElIdNum = elements.length;
  for (var chI = 0; chI < chosen.length; chI++) {
    var it = chosen[chI];
    var out2 = { id: 'c' + (chI + 1), type: it.kind };
    if (it.title) out2.title = it.title;
    if (it.price) out2.price = it.price;
    if (it.numericPrice !== undefined) out2.numericPrice = it.numericPrice;
    if (it.currency) out2.currency = it.currency;
    if (it.text) out2.text = it.text;
    if (it.href) out2.href = it.href;

    if (it._linkEl) {
      // Content-item links are addressed the SAME way as any other
      // interactive element — stamped with data-jarvis-id and resolved by
      // the existing interaction skill. A link already in the interactive
      // budget keeps its id; one that was crowded out (the actual Nike
      // failure) gets a fresh id here so it stays clickable regardless.
      var existingId = it._linkEl.getAttribute(attr);
      if (!existingId) {
        nextElIdNum++;
        existingId = 'e' + nextElIdNum;
        it._linkEl.setAttribute(attr, existingId);
        it._linkEl.setAttribute(genAttr, String(version));
      }
      out2.linkedElementId = existingId;
      out2.primaryActionElementId = existingId;
      out2.actionRole = it._actionRole || 'unknown';
    }
    if (it._secondaryEls && it._secondaryEls.length) {
      var secIds = [];
      for (var se = 0; se < it._secondaryEls.length; se++) {
        var secId = it._secondaryEls[se].getAttribute(attr);
        if (secId && secId !== out2.primaryActionElementId) secIds.push(secId);
      }
      if (secIds.length) out2.secondaryActionElementIds = secIds;
    }
    contentItems.push(out2);
  }

  return {
    totalFound: totalFound,
    truncated: totalFound > picked.length,
    elements: elements,
    contentItems: contentItems,
    contentItemsTotalFound: contentItemsTotalFound,
    contentItemsWithPrice: withPrice.length,
    contentItemsTruncated: contentItemsTotalFound > chosen.length,
    registryVersion: version
  };
}`;

export class ElementRegistry {
  /**
   * Snapshot the page and stamp resolvable ids. Never throws: an observation
   * failure must degrade to "no elements", not abort the task.
   */
  static async snapshot(page: Page, opts: SnapshotOptions = {}): Promise<RegistrySnapshot> {
    const max = opts.max ?? DEFAULTS.max;
    const maxLinks = opts.maxLinks ?? DEFAULTS.maxLinks;
    const maxContentItems = opts.maxContentItems ?? DEFAULTS.maxContentItems;
    const version = opts.version ?? 1;
    try {
      const args = JSON.stringify({
        attr: JARVIS_ID_ATTR,
        genAttr: JARVIS_GEN_ATTR,
        version,
        max,
        maxLinks,
        maxContentItems,
      });
      const result = (await page.evaluate(
        `(${COLLECT_SRC})(${args})`
      )) as RegistrySnapshot;
      return result;
    } catch (error) {
      console.error('[registry] snapshot failed:', (error as Error).message?.split('\n')[0]);
      return {
        elements: [],
        totalFound: 0,
        truncated: false,
        contentItems: [],
        contentItemsTotalFound: 0,
        contentItemsWithPrice: 0,
        contentItemsTruncated: false,
        registryVersion: version,
      };
    }
  }

  /** CSS selector that resolves a registry id back to its element. */
  static selectorFor(elementId: string): string {
    return `[${JARVIS_ID_ATTR}="${cssEscape(elementId)}"]`;
  }

  /** Generation this element id was stamped with, if it still resolves. */
  static async generationOf(page: Page, elementId: string): Promise<string | null> {
    const loc = page.locator(ElementRegistry.selectorFor(elementId)).first();
    if ((await loc.count().catch(() => 0)) === 0) return null;
    return loc.getAttribute(JARVIS_GEN_ATTR).catch(() => null);
  }
}

/** Minimal attribute-value escape; registry ids are `e\d+` but stay defensive. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
