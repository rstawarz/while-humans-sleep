/**
 * Tests for the plan parser
 */

import { describe, it, expect } from "vitest";
import { parsePlanDocument, validateDependencies, parseAndValidatePlan } from "./plan-parser.js";

describe("parsePlanDocument", () => {
  it("parses a simple epic with one story", () => {
    const content = `
# Epic: User Authentication

Add auth to the API.

## Story: Add login endpoint
**Priority**: 1
**Type**: task

Create the login endpoint.
`;

    const result = parsePlanDocument(content);

    expect(result.errors).toHaveLength(0);
    expect(result.epics).toHaveLength(1);
    expect(result.epics[0].title).toBe("User Authentication");
    expect(result.epics[0].description).toBe("Add auth to the API.");
    expect(result.epics[0].stories).toHaveLength(1);
    expect(result.epics[0].stories[0].title).toBe("Add login endpoint");
    expect(result.epics[0].stories[0].priority).toBe(1);
    expect(result.epics[0].stories[0].type).toBe("task");
    expect(result.epics[0].stories[0].description).toBe("Create the login endpoint.");
  });

  it("parses multiple stories with dependencies", () => {
    const content = `
# Epic: Auth System

## Story: Database setup
**Priority**: 0
**Type**: task

Set up the database.

## Story: Add users table
**Priority**: 1
**Type**: task
**Depends on**: Database setup

Create users table.

## Story: Add login
**Priority**: 2
**Type**: feature
**Depends on**: Database setup, Add users table

Implement login.
`;

    const result = parsePlanDocument(content);

    expect(result.errors).toHaveLength(0);
    expect(result.epics[0].stories).toHaveLength(3);

    const login = result.epics[0].stories[2];
    expect(login.title).toBe("Add login");
    expect(login.dependsOn).toEqual(["Database setup", "Add users table"]);
  });

  it("uses default values when metadata is missing", () => {
    const content = `
# Epic: Test

## Story: Minimal story

Just a description.
`;

    const result = parsePlanDocument(content);

    expect(result.errors).toHaveLength(0);
    const story = result.epics[0].stories[0];
    expect(story.priority).toBe(2); // Default
    expect(story.type).toBe("task"); // Default
    expect(story.dependsOn).toEqual([]);
  });

  it("handles multiple epics", () => {
    const content = `
# Epic: First Epic

First description.

## Story: First story

Story in first epic.

# Epic: Second Epic

Second description.

## Story: Second story

Story in second epic.
`;

    const result = parsePlanDocument(content);

    expect(result.errors).toHaveLength(0);
    expect(result.epics).toHaveLength(2);
    expect(result.epics[0].title).toBe("First Epic");
    expect(result.epics[0].stories[0].title).toBe("First story");
    expect(result.epics[1].title).toBe("Second Epic");
    expect(result.epics[1].stories[0].title).toBe("Second story");
  });

  it("reports error for story outside epic", () => {
    const content = `
## Story: Orphan story

No epic above.
`;

    const result = parsePlanDocument(content);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Story found outside of epic");
  });

  it("reports error for invalid priority", () => {
    const content = `
# Epic: Test

## Story: Bad priority
**Priority**: 9

Description.
`;

    const result = parsePlanDocument(content);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Invalid priority");
  });

  it("reports error for invalid type", () => {
    const content = `
# Epic: Test

## Story: Bad type
**Type**: invalid

Description.
`;

    const result = parsePlanDocument(content);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Invalid type");
  });

  it("handles multiline descriptions", () => {
    const content = `
# Epic: Test

## Story: Complex story
**Priority**: 1

This is a multiline description.

It has:
- Bullet points
- Multiple paragraphs

And more content.
`;

    const result = parsePlanDocument(content);

    expect(result.errors).toHaveLength(0);
    const description = result.epics[0].stories[0].description;
    expect(description).toContain("multiline description");
    expect(description).toContain("Bullet points");
    expect(description).toContain("And more content");
  });
});

describe("validateDependencies", () => {
  it("returns no errors for valid dependencies", () => {
    const plan = {
      epics: [
        {
          title: "Epic",
          description: "",
          stories: [
            { title: "First", priority: 1, type: "task" as const, description: "", dependsOn: [] },
            { title: "Second", priority: 2, type: "task" as const, description: "", dependsOn: ["First"] },
          ],
        },
      ],
      errors: [],
    };

    const errors = validateDependencies(plan);
    expect(errors).toHaveLength(0);
  });

  it("returns error for unknown dependency", () => {
    const plan = {
      epics: [
        {
          title: "Epic",
          description: "",
          stories: [
            { title: "Story", priority: 1, type: "task" as const, description: "", dependsOn: ["NonExistent"] },
          ],
        },
      ],
      errors: [],
    };

    const errors = validateDependencies(plan);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("unknown story");
  });

  it("validates dependencies case-insensitively", () => {
    const plan = {
      epics: [
        {
          title: "Epic",
          description: "",
          stories: [
            { title: "First Story", priority: 1, type: "task" as const, description: "", dependsOn: [] },
            { title: "Second", priority: 2, type: "task" as const, description: "", dependsOn: ["first story"] },
          ],
        },
      ],
      errors: [],
    };

    const errors = validateDependencies(plan);
    expect(errors).toHaveLength(0);
  });
});

describe("parseAndValidatePlan", () => {
  it("combines parsing and validation", () => {
    const content = `
# Epic: Test

## Story: First
**Priority**: 1

Description.

## Story: Second
**Depends on**: First, NonExistent

Description.
`;

    const result = parseAndValidatePlan(content);

    expect(result.epics).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("NonExistent");
  });
});
