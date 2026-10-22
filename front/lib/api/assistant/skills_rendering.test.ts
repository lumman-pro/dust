import { getEnabledSkillInstructions } from "@app/lib/api/assistant/skills_rendering";
import { buildFramesV2Instructions } from "@app/lib/resources/skill/code_defined/global/frames_v2";
import type { SkillResource } from "@app/lib/resources/skill/skill_resource";
import { describe, expect, it } from "vitest";

type SkillInstructionsSource = Pick<
  SkillResource,
  "sId" | "name" | "instructions"
>;

function makeEnabledSkill(
  overrides: Partial<SkillInstructionsSource>
): SkillInstructionsSource {
  return {
    sId: "research",
    name: "ResearchSkill",
    instructions: "",
    ...overrides,
  };
}

const FRAMES_INSTRUCTIONS = buildFramesV2Instructions({
  hasFunctions: false,
  hasPublicFunctions: false,
  hasDrafts: false,
  hasSchedules: false,
  isPod: false,
});

describe("getEnabledSkillInstructions", () => {
  it("strips tool icon attributes from model-facing skill instructions", () => {
    const skill = makeEnabledSkill({
      instructions:
        'Use <tool id="mcp_server_view_1" name="GitHub Search" icon="GithubLogo" />.',
    });

    expect(getEnabledSkillInstructions(skill)).toContain(
      '<tool id="mcp_server_view_1" name="GitHub Search" />'
    );
    expect(getEnabledSkillInstructions(skill)).not.toContain(
      'icon="GithubLogo"'
    );
  });

  it("strips skill icon attributes from model-facing skill instructions", () => {
    const skill = makeEnabledSkill({
      instructions:
        'Use <skill id="skill_123" name="Create memo" icon="book_open" />.',
    });

    expect(getEnabledSkillInstructions(skill)).toContain(
      '<skill id="skill_123" name="Create memo" />'
    );
    expect(getEnabledSkillInstructions(skill)).not.toContain(
      'icon="book_open"'
    );
  });

  it("renders enabled frame skill messages with v2 authoring prose", () => {
    const skill = makeEnabledSkill({
      sId: "frames",
      name: "Create Frames",
      instructions: FRAMES_INSTRUCTIONS,
    });

    const instructions = getEnabledSkillInstructions(skill);

    expect(instructions).toContain("### Rendering Context");
  });

  it("frame instructions do not contain v1-only markers", () => {
    // Guards against re-importing the legacy viz authoring prose (still used
    // by other servers) into the frames instructions.
    expect(FRAMES_INSTRUCTIONS).not.toContain("Premium, Minimalist Aesthetic");
  });
});
