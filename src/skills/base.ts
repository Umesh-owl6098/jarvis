import { z } from 'zod';

/**
 * Base class for all agent skills.
 * Skills are deterministic, reusable operations that the agent can invoke.
 * Each skill encapsulates a specific capability (navigation, interaction, extraction).
 */

export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  version: string;
}

export interface SkillInput {
  schema: z.ZodSchema;
}

export interface SkillOutput {
  success: boolean;
  result?: unknown;
  error?: string;
}

export abstract class BaseSkill {
  abstract metadata: SkillMetadata;
  abstract inputSchema: z.ZodSchema;

  /**
   * Execute the skill with validated input.
   * Throws if input is invalid or execution fails.
   */
  abstract execute(input: unknown): Promise<SkillOutput>;

  /**
   * Validate input against the schema.
   */
  validateInput(input: unknown): void {
    try {
      this.inputSchema.parse(input);
    } catch (error) {
      throw new Error(`Skill input validation failed: ${error}`);
    }
  }

  /**
   * Get compact metadata for planner.
   * Sent to LLM to describe what this skill can do.
   */
  getMetadataForPlanner(): SkillMetadata {
    return this.metadata;
  }
}
