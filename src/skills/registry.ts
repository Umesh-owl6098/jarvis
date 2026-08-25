import { BaseSkill, SkillMetadata } from './base';

/**
 * SkillRegistry: Manages available skills and provides metadata to planner.
 * Keeps LLM context lean by sending only compact skill descriptions,
 * not full implementations.
 */
export class SkillRegistry {
  private skills: Map<string, BaseSkill> = new Map();

  register(skill: BaseSkill): void {
    this.skills.set(skill.metadata.id, skill);
  }

  getSkill(id: string): BaseSkill | undefined {
    return this.skills.get(id);
  }

  /**
   * Get compact metadata for all skills.
   * This is what gets sent to the LLM planner.
   */
  getMetadataForPlanner(): SkillMetadata[] {
    return Array.from(this.skills.values()).map(skill => skill.getMetadataForPlanner());
  }

  /**
   * List all available skills (for debugging).
   */
  listSkills(): string[] {
    return Array.from(this.skills.keys());
  }

  /**
   * Get human-readable skill descriptions for the planner prompt.
   */
  getSkillsPrompt(): string {
    const skills = this.getMetadataForPlanner();
    return skills
      .map(s => `- ${s.id}: ${s.description}`)
      .join('\n');
  }
}

export const skillRegistry = new SkillRegistry();
