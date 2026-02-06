/**
 * Plan Parser - Parses markdown planning documents into structured data
 *
 * This module parses planning documents written in a specific markdown format
 * and extracts epics, stories, and their metadata for import into beads.
 */

export interface PlanStory {
  title: string;
  priority: number;
  type: "task" | "bug" | "feature" | "chore";
  description: string;
  dependsOn: string[]; // Story titles this depends on
}

export interface PlanEpic {
  title: string;
  description: string;
  stories: PlanStory[];
}

export interface ParsedPlan {
  epics: PlanEpic[];
  errors: string[];
}

/**
 * Parses a markdown planning document into structured data
 *
 * Expected format:
 * ```markdown
 * # Epic: Title
 *
 * Epic description here.
 *
 * ## Story: Title
 * **Priority**: 1
 * **Type**: task
 * **Depends on**: Other story title
 *
 * Story description here.
 * ```
 */
export function parsePlanDocument(content: string): ParsedPlan {
  const lines = content.split("\n");
  const epics: PlanEpic[] = [];
  const errors: string[] = [];

  let currentEpic: PlanEpic | null = null;
  let currentStory: PlanStory | null = null;
  let currentSection: "epic" | "story" | null = null;
  let descriptionLines: string[] = [];

  const flushDescription = () => {
    const description = descriptionLines
      .join("\n")
      .trim()
      // Remove leading/trailing blank lines
      .replace(/^\n+|\n+$/g, "");

    if (currentStory && currentSection === "story") {
      currentStory.description = description;
    } else if (currentEpic && currentSection === "epic") {
      currentEpic.description = description;
    }
    descriptionLines = [];
  };

  const flushStory = () => {
    flushDescription();
    if (currentStory && currentEpic) {
      currentEpic.stories.push(currentStory);
      currentStory = null;
    }
  };

  const flushEpic = () => {
    flushStory();
    if (currentEpic) {
      epics.push(currentEpic);
      currentEpic = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Check for epic header: # Epic: Title
    const epicMatch = line.match(/^#\s+Epic:\s*(.+)$/i);
    if (epicMatch) {
      flushEpic();
      currentEpic = {
        title: epicMatch[1].trim(),
        description: "",
        stories: [],
      };
      currentSection = "epic";
      continue;
    }

    // Check for story header: ## Story: Title
    const storyMatch = line.match(/^##\s+Story:\s*(.+)$/i);
    if (storyMatch) {
      if (!currentEpic) {
        errors.push(`Line ${lineNum}: Story found outside of epic`);
        continue;
      }
      flushStory();
      currentStory = {
        title: storyMatch[1].trim(),
        priority: 2, // Default priority
        type: "task", // Default type
        description: "",
        dependsOn: [],
      };
      currentSection = "story";
      continue;
    }

    // Check for metadata lines (only in story section)
    if (currentStory && currentSection === "story") {
      // Priority: **Priority**: 1 or **Priority:** 1
      const priorityMatch = line.match(/^\*\*Priority\*\*:\s*(\d+)/i);
      if (priorityMatch) {
        const priority = parseInt(priorityMatch[1], 10);
        if (priority >= 0 && priority <= 4) {
          currentStory.priority = priority;
        } else {
          errors.push(`Line ${lineNum}: Invalid priority ${priority}, must be 0-4`);
        }
        continue;
      }

      // Type: **Type**: task
      const typeMatch = line.match(/^\*\*Type\*\*:\s*(\w+)/i);
      if (typeMatch) {
        const type = typeMatch[1].toLowerCase();
        if (["task", "bug", "feature", "chore"].includes(type)) {
          currentStory.type = type as PlanStory["type"];
        } else {
          errors.push(`Line ${lineNum}: Invalid type "${type}", must be task/bug/feature/chore`);
        }
        continue;
      }

      // Depends on: **Depends on**: Story A, Story B
      const dependsMatch = line.match(/^\*\*Depends on\*\*:\s*(.+)/i);
      if (dependsMatch) {
        currentStory.dependsOn = dependsMatch[1]
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        continue;
      }
    }

    // Skip empty lines at the start of a section
    if (descriptionLines.length === 0 && line.trim() === "") {
      continue;
    }

    // Accumulate description lines
    if (currentSection) {
      descriptionLines.push(line);
    }
  }

  // Flush remaining content
  flushEpic();

  return { epics, errors };
}

/**
 * Validates that all dependencies reference existing stories
 */
export function validateDependencies(plan: ParsedPlan): string[] {
  const errors: string[] = [];
  const allStoryTitles = new Set<string>();

  // Collect all story titles
  for (const epic of plan.epics) {
    for (const story of epic.stories) {
      allStoryTitles.add(story.title.toLowerCase());
    }
  }

  // Check dependencies
  for (const epic of plan.epics) {
    for (const story of epic.stories) {
      for (const dep of story.dependsOn) {
        if (!allStoryTitles.has(dep.toLowerCase())) {
          errors.push(`Story "${story.title}" depends on unknown story "${dep}"`);
        }
      }
    }
  }

  return errors;
}

/**
 * Parses and validates a plan document
 */
export function parseAndValidatePlan(content: string): ParsedPlan {
  const plan = parsePlanDocument(content);
  const depErrors = validateDependencies(plan);
  plan.errors.push(...depErrors);
  return plan;
}
