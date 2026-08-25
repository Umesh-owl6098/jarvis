/**
 * Deterministic URL normalization.
 *
 * Scope is deliberately narrow: accept what a person reasonably types for a
 * destination ("amazon.com", "www.amazon.com") and turn it into an absolute
 * https URL. Anything requiring interpretation stays the LLM's job.
 */

/** Schemes we are willing to navigate to. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

export interface NormalizedUrl {
  url: string;
  /** True when a scheme had to be added. */
  addedScheme: boolean;
}

/**
 * Bare-domain shape: one or more dot-separated labels ending in a TLD of 2+
 * letters, with an optional port/path/query/fragment. Deliberately strict —
 * it must not swallow arbitrary prose.
 */
const BARE_DOMAIN =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#].*)?$/i;

export function normalizeUrl(input: string): NormalizedUrl {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('No URL provided');

  // Strip wrapping quotes/angle brackets people paste in.
  const cleaned = raw.replace(/^["'<]+|["'>]+$/g, '').trim();

  // about:blank and similar internal targets pass through untouched.
  if (/^about:/i.test(cleaned)) return { url: cleaned, addedScheme: false };

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned)) {
    const parsed = new URL(cleaned);
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
      throw new Error(`Unsupported URL scheme: ${parsed.protocol}`);
    }
    return { url: parsed.toString(), addedScheme: false };
  }

  // Reject scheme-like prefixes we do not navigate (javascript:, data:, file:…)
  if (/^[a-z][a-z0-9+.-]*:/i.test(cleaned)) {
    throw new Error(`Unsupported URL scheme in "${cleaned}"`);
  }

  if (!BARE_DOMAIN.test(cleaned)) {
    throw new Error(`Not a navigable URL or domain: "${cleaned}"`);
  }

  const parsed = new URL(`https://${cleaned}`);
  return { url: parsed.toString(), addedScheme: true };
}

/** Convenience wrapper returning just the URL string. */
export function toAbsoluteUrl(input: string): string {
  return normalizeUrl(input).url;
}

/** Registrable-ish host comparison, ignoring a leading `www.`. */
export function sameSite(a: string, b: string): boolean {
  const host = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
      return '';
    }
  };
  const ha = host(a);
  const hb = host(b);
  if (!ha || !hb) return false;
  return ha === hb || ha.endsWith(`.${hb}`) || hb.endsWith(`.${ha}`);
}
