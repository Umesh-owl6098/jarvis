import { Locator, Page } from 'playwright';

/**
 * ElementRegistry: Maps compact element IDs (e1, e2, e3, ...) to actual Playwright locators.
 *
 * Why:
 * - LLM should say "click e1" not "click div:nth-child(7) > button"
 * - Selectors are brittle; IDs are stable within a page state
 * - Registry rebuilt after page navigation or state change
 *
 * How:
 * - Extract all interactive elements from DOM
 * - Assign stable IDs (e1, e2, e3, ...)
 * - Store locators for each ID
 * - LLM uses IDs, executor resolves to locators
 */

export interface ElementInfo {
  id: string;
  type: string;
  text?: string;
  ariaLabel?: string;
  locator: Locator;
}

export class ElementRegistry {
  private elements: Map<string, ElementInfo> = new Map();

  /**
   * Build registry from current page state.
   * Queries DOM for interactive elements and assigns stable IDs.
   */
  async buildFromPage(page: Page): Promise<void> {
    this.elements.clear();

    // Get all interactive elements from DOM with CSS selectors
    const elements = await page.evaluate(() => {
      const result: any[] = [];

      // Query all interactive elements
      const selectorConfigs = [
        { selector: 'button', type: 'button' },
        { selector: 'a', type: 'link' },
        { selector: 'input[type="text"]', type: 'textbox' },
        { selector: 'input[type="search"]', type: 'search' },
        { selector: 'textarea', type: 'textarea' },
        { selector: 'select', type: 'select' },
      ];

      selectorConfigs.forEach(({ selector, type }) => {
        document.querySelectorAll(selector).forEach((el) => {
          // Skip hidden elements
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return;

          let text = '';
          if (el instanceof HTMLButtonElement) text = el.textContent?.trim() || '';
          else if (el instanceof HTMLAnchorElement) text = el.textContent?.trim() || '';
          else if (el instanceof HTMLInputElement)
            text = el.placeholder || el.value || el.getAttribute('aria-label') || '';
          else if (el instanceof HTMLTextAreaElement)
            text = el.placeholder || el.getAttribute('aria-label') || '';
          else if (el instanceof HTMLSelectElement)
            text = el.options[el.selectedIndex]?.text || '';

          result.push({
            type,
            text: text.substring(0, 50),
            ariaLabel: el.getAttribute('aria-label'),
            selector, // Keep the selector for locator creation
          });
        });
      });

      return result;
    });

    // Assign stable IDs and create locators using CSS selectors
    elements.forEach((el, idx) => {
      const id = `e${idx + 1}`;
      this.elements.set(id, {
        id,
        type: el.type,
        text: el.text,
        ariaLabel: el.ariaLabel,
        locator: page.locator(el.selector).nth(elements.filter(e => e.selector === el.selector).indexOf(el)),
      });
    });
  }

  /**
   * Get locator for an element ID.
   * Returns undefined if ID not found.
   */
  getLocator(elementId: string): Locator | undefined {
    return this.elements.get(elementId)?.locator;
  }

  /**
   * Get element info (for debugging).
   */
  getElement(elementId: string): ElementInfo | undefined {
    return this.elements.get(elementId);
  }

  /**
   * List all elements in registry.
   */
  listElements(): ElementInfo[] {
    return Array.from(this.elements.values());
  }

  /**
   * Get registry size.
   */
  size(): number {
    return this.elements.size;
  }

  /**
   * Clear registry (when page changes).
   */
  clear(): void {
    this.elements.clear();
  }
}
