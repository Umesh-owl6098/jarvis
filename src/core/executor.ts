/**
 * ActionExecutor: Execute validated AgentActions deterministically.
 *
 * Input: AgentAction (validated by Zod)
 * Output: StructuredResult
 *
 * This executor does NOT use LLM. It runs skills directly.
 * This is the ONLY place browser interactions happen.
 */

import { AgentAction, AgentActionSchema } from './action';
import { BrowserController } from './browser/controller';
import { ElementRegistry } from './element-registry';
import { z } from 'zod';

export const ErrorCodeSchema = z.enum([
  'ELEMENT_NOT_FOUND',
  'ELEMENT_NOT_VISIBLE',
  'ELEMENT_NOT_ENABLED',
  'NAVIGATION_TIMEOUT',
  'PAGE_LOAD_FAILED',
  'ACTION_TIMEOUT',
  'INVALID_ACTION',
  'STALE_OBSERVATION',
  'SKILL_FAILURE',
  'UNKNOWN_ERROR',
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ExecutorResultSchema = z.object({
  success: z.boolean(),
  action: z.string(),
  message: z.string(),
  data: z.unknown().optional(),
  error: z.object({
    code: ErrorCodeSchema.optional(),
    retryable: z.boolean().optional(),
  }).optional(),
});

export type ExecutorResult = z.infer<typeof ExecutorResultSchema>;

export class ActionExecutor {
  constructor(
    private browser: BrowserController,
    private elementRegistry: ElementRegistry,
  ) {}

  /**
   * Execute a validated action.
   * Returns structured result (not exceptions).
   */
  async execute(action: AgentAction): Promise<ExecutorResult> {
    try {
      // Validate action
      const validated = AgentActionSchema.parse(action);

      // Dispatch to appropriate handler
      switch (validated.type) {
        case 'navigate':
          return await this.handleNavigate(validated as any);
        case 'click':
          return await this.handleClick(validated as any);
        case 'type':
          return await this.handleType(validated as any);
        case 'scroll':
          return await this.handleScroll(validated as any);
        case 'extract':
          return await this.handleExtract(validated as any);
        case 'finish':
          return await this.handleFinish(validated as any);
        default:
          return {
            success: false,
            action: 'unknown',
            message: `Unknown action type`,
          };
      }
    } catch (error: any) {
      return {
        success: false,
        action: 'error',
        message: error.message || 'Unknown error',
      };
    }
  }

  private async handleNavigate(action: any): Promise<ExecutorResult> {
    try {
      await this.browser.goto(action.url);

      // Refresh element registry after navigation
      if (this.browser.getPage()) {
        await this.elementRegistry.buildFromPage(this.browser.getPage()!);
      }

      return {
        success: true,
        action: 'navigate',
        message: `Navigated to ${action.url}`,
        data: {
          url: action.url,
          elementsFound: this.elementRegistry.size(),
        },
      };
    } catch (error: any) {
      return {
        success: false,
        action: 'navigate',
        message: `Failed to navigate: ${error.message}`,
      };
    }
  }

  private async handleClick(action: any): Promise<ExecutorResult> {
    try {
      const locator = this.elementRegistry.getLocator(action.elementId);
      if (!locator) {
        return {
          success: false,
          action: 'click',
          message: `Element ${action.elementId} not found in registry`,
          error: {
            code: 'ELEMENT_NOT_FOUND',
            retryable: true, // Can retry after observing page again
          },
        };
      }

      // Check if element is visible
      const isVisible = await locator.isVisible().catch(() => false);
      if (!isVisible) {
        return {
          success: false,
          action: 'click',
          message: `Element ${action.elementId} is not visible`,
          error: {
            code: 'ELEMENT_NOT_VISIBLE',
            retryable: true,
          },
        };
      }

      // Check if element is enabled
      const isEnabled = await locator.isEnabled().catch(() => true); // Default to enabled if can't check
      if (!isEnabled) {
        return {
          success: false,
          action: 'click',
          message: `Element ${action.elementId} is not enabled`,
          error: {
            code: 'ELEMENT_NOT_ENABLED',
            retryable: false,
          },
        };
      }

      await locator.click();

      return {
        success: true,
        action: 'click',
        message: `Clicked element ${action.elementId}`,
      };
    } catch (error: any) {
      // Try to classify the error
      let errorCode: ErrorCode = 'SKILL_FAILURE';
      if (error.message.includes('Timeout')) {
        errorCode = 'ACTION_TIMEOUT';
      }

      return {
        success: false,
        action: 'click',
        message: `Failed to click ${action.elementId}: ${error.message}`,
        error: {
          code: errorCode,
          retryable: errorCode === 'ACTION_TIMEOUT',
        },
      };
    }
  }

  private async handleType(action: any): Promise<ExecutorResult> {
    try {
      const locator = this.elementRegistry.getLocator(action.elementId);
      if (!locator) {
        return {
          success: false,
          action: 'type',
          message: `Element ${action.elementId} not found in registry`,
        };
      }

      await locator.fill(action.text);

      return {
        success: true,
        action: 'type',
        message: `Typed into element ${action.elementId}`,
        data: { text: action.text.substring(0, 50) },
      };
    } catch (error: any) {
      return {
        success: false,
        action: 'type',
        message: `Failed to type: ${error.message}`,
      };
    }
  }

  private async handleScroll(action: any): Promise<ExecutorResult> {
    try {
      await this.browser.scroll(action.direction, action.amount);

      return {
        success: true,
        action: 'scroll',
        message: `Scrolled ${action.direction} by ${action.amount}`,
      };
    } catch (error: any) {
      return {
        success: false,
        action: 'scroll',
        message: `Failed to scroll: ${error.message}`,
      };
    }
  }

  private async handleExtract(action: any): Promise<ExecutorResult> {
    try {
      let text = '';

      if (action.elementId) {
        // Extract from specific element
        const locator = this.elementRegistry.getLocator(action.elementId);
        if (!locator) {
          return {
            success: false,
            action: 'extract',
            message: `Element ${action.elementId} not found`,
          };
        }
        text = await locator.textContent().then(t => t || '');
      } else {
        // Extract all visible text
        text = await this.browser.getVisibleText();
      }

      return {
        success: true,
        action: 'extract',
        message: `Extracted ${text.length} characters`,
        data: {
          text: text.substring(0, 500), // Limit output
          length: text.length,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        action: 'extract',
        message: `Failed to extract: ${error.message}`,
      };
    }
  }

  private async handleFinish(action: any): Promise<ExecutorResult> {
    return {
      success: true,
      action: 'finish',
      message: action.result,
      data: { result: action.result },
    };
  }
}
