import { InternalMCPServerInMemoryResource } from "@app/lib/resources/internal_mcp_server_in_memory_resource";
import { framesSkill } from "@app/lib/resources/skill/code_defined/global/frames";
import { FeatureFlagFactory } from "@app/tests/utils/FeatureFlagFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import type { AgentLoopExecutionData } from "@app/types/assistant/agent_run";
import { describe, expect, it } from "vitest";

const POD_V2_PLACEMENT_MARKER =
  "new Frames still go in the conversation folder";

function agentLoopDataInPod(spaceId: string | null): AgentLoopExecutionData {
  return {
    conversation: { metadata: { useFileSystem: true }, spaceId },
  } as unknown as AgentLoopExecutionData;
}

describe("framesSkill.fetchInstructions", () => {
  it("uses the dsbx lifecycle and keeps MCP export", async () => {
    const { authenticator: auth } = await createResourceTest({});
    await FeatureFlagFactory.basic(auth, "frames_v2_functions");

    const instructions = await framesSkill.fetchInstructions(auth, {
      spaceIds: [],
    });

    expect(instructions).toContain("dsbx frame publish");
    expect(instructions).toContain(
      "`dsbx frame publish` and `validate` reject them"
    );
    expect(instructions).toContain('mkdir -p "$FRAME"');
    expect(instructions).toContain(
      "write the real source\nand publish a new Frame in one Computer command"
    );
    expect(instructions).toContain("There is no scaffold step");
    expect(instructions).not.toContain("dsbx frame create");
    expect(instructions).not.toContain("dsbx frame register");
    expect(instructions).toContain("dsbx frame share-link");
    expect(instructions).toContain("dsbx frame call");
    expect(instructions).toContain("stable Frame ID");
    expect(instructions).toContain("additionally requires read access");
    expect(instructions).toContain("does not test the Frame");
    expect(instructions).toContain("dsbx db list --frame <frame-id>");
    expect(instructions).toContain("dsbx db query comments --frame <frame-id>");
    expect(instructions).not.toContain("dsbx frame validate");
    expect(instructions).toContain(
      'bash "/files/conversation-<conversationId>/skills/Create Frames/lint.sh" "$FRAME"'
    );
    expect(instructions).toContain("Fix those errors before");
    expect(instructions).toContain(
      "keeps generated configs on local sandbox disk"
    );
    expect(instructions).toContain("configs untouched");
    expect(instructions).toContain(
      "Frame sharing and use rights are configured by the user in the Dust UI"
    );
    expect(instructions).toContain("This command is read-only");
    expect(instructions).not.toContain("--scope");
    expect(instructions).not.toContain("--email");
    expect(instructions).toContain("package-like folder");
    expect(instructions).toContain("canonical Frame resource");
    expect(instructions).toContain("`index.tsx` by default");
    expect(instructions).toContain("single `.tsx` entry file");
    expect(instructions).toContain("publication and makes it live");
    expect(instructions).not.toContain("atomically activates the publication");
    expect(instructions).toContain(
      "Call a function from the Frame's current publication\nby its stable Frame ID"
    );
    expect(instructions).toContain("## Authoring a function");
    expect(instructions).toContain('userIdentity: "workspace_user_required"');
    expect(instructions).toContain("### Fast and durable functions");
    expect(instructions).toContain("tools.call");
    expect(instructions).toContain('import { tools } from "@dust/pod"');
    expect(instructions).toContain(
      "Computer vs Frame function — do not mix the two call styles"
    );
    expect(instructions).not.toContain(
      "Inside a durable function, shell out to:"
    );
    expect(instructions).toContain("useFrameFunctionMutation");
    expect(instructions).toContain("data` is typed as `unknown`");
    expect(instructions).toContain("as CommentList | undefined");
    expect(instructions).toContain("isMutating");
    expect(instructions).toContain("## Persisting state in a Frame database");
    expect(instructions).toContain('db("comments")');
    expect(instructions).toContain("reconciles the declared schemas");
    expect(instructions).toContain("move its folder with\n  `files__move`");
    expect(instructions).not.toContain("defaultStake");
    expect(instructions).toContain("### React Component Rules");
    expect(instructions).toContain("### Slideshows");
    expect(instructions).toContain("Keep the built-in width and height");
    expect(instructions).toContain("legacy Frame");
    expect(instructions).toContain("<frame>.tsx");
    expect(instructions).toContain(
      "Chat apps, task lists, trackers, forms, CRUD apps"
    );
    expect(instructions).toContain(
      "Do not store durable application state in memory; use a Frame database"
    );
    expect(instructions).toContain(
      "Use the Computer to create and edit their source"
    );
    expect(instructions).toContain("Do not pass the convenience aliases");
    expect(instructions).toContain("`/files/conversation` or `/files/pod`");
    expect(instructions).toContain(
      "Never run concurrent file mutations against the same path"
    );
    expect(instructions).toContain(
      "Do not replace an entire UI or function for a localized"
    );
    expect(instructions).toContain(
      "mark required fields in a newly created table as `.notNull()`"
    );
    expect(instructions).toContain("shared Zod domain");
    expect(instructions).toContain("instead of `bun build`");
    expect(instructions).toContain(
      "`export_interactive_content_file`: export a Frame as a PNG screenshot or PDF document"
    );
    expect(instructions).toContain(
      "`create_interactive_content_file`: create a Frame from an existing template"
    );
    expect(framesSkill.mcpServers).toEqual([{ name: "interactive_content" }]);
    await expect(
      InternalMCPServerInMemoryResource.isRestrictedForWorkspace(
        auth,
        "interactive_content"
      )
    ).resolves.toBe(false);
  });

  it("teaches function schedules only when the schedules flag is on", async () => {
    const { authenticator: auth } = await createResourceTest({});
    await FeatureFlagFactory.basic(auth, "frames_v2_functions");

    const withoutSchedules = await framesSkill.fetchInstructions(auth, {
      spaceIds: [],
    });
    expect(withoutSchedules).not.toContain(
      "## Run a durable function on a schedule"
    );
    expect(withoutSchedules).not.toContain('"schedules"');

    await FeatureFlagFactory.basic(auth, "frames_v2_schedules");

    const withSchedules = await framesSkill.fetchInstructions(auth, {
      spaceIds: [],
    });
    expect(withSchedules).toContain("## Run a durable function on a schedule");
    expect(withSchedules).toContain('"cron": "0 * * * *"');
    expect(withSchedules).toContain("do not run yet");
  });

  it("teaches client-only Frames without Frame functions", async () => {
    const { authenticator: auth } = await createResourceTest({});

    const instructions = await framesSkill.fetchInstructions(auth, {
      spaceIds: [],
    });

    expect(instructions).toContain("dsbx frame publish");
    expect(instructions).toContain("Frames in this workspace are client-only");
    expect(instructions).toContain(
      "`dsbx frame publish` and `validate` reject them"
    );
    expect(instructions).toContain("this workspace rejects them at publish");
    expect(instructions).toContain("triggerUserFileDownload");
    expect(instructions).not.toContain("Do not offer a download button");
    expect(instructions).not.toContain("## Authoring a function");
    expect(instructions).not.toContain(
      "## Persisting state in a Frame database"
    );
    expect(instructions).not.toContain("## Storing files in a Frame");
    expect(instructions).not.toContain("## Migrating a legacy Frame");
    expect(instructions).not.toContain("useFrameFunction");
    expect(instructions).not.toContain("tools.call");
    expect(instructions).not.toContain("dsbx frame call");
    expect(instructions).not.toContain("dsbx db");
    expect(instructions).not.toContain("frame_author_required");
    expect(instructions).not.toContain("--replaces");
  });

  it("teaches functions for public visitors only when public functions are enabled", async () => {
    const { authenticator: auth } = await createResourceTest({});
    await FeatureFlagFactory.basic(auth, "frames_v2_functions");
    const { authenticator: publicAuth } = await createResourceTest({});
    await FeatureFlagFactory.basic(publicAuth, "frames_v2_functions");
    await FeatureFlagFactory.basic(publicAuth, "frames_v2_public_functions");

    const withoutPublicFunctions = await framesSkill.fetchInstructions(auth, {
      spaceIds: [],
    });
    const withPublicFunctions = await framesSkill.fetchInstructions(
      publicAuth,
      { spaceIds: [] }
    );

    expect(withoutPublicFunctions).not.toContain(
      "## Functions for public visitors"
    );
    expect(withPublicFunctions).toContain("## Functions for public visitors");
    expect(withPublicFunctions).toContain(
      "A non-null user is a workspace member"
    );
  });

  it("teaches draft mode and make-live when drafts are enabled", async () => {
    const { authenticator: auth } = await createResourceTest({});
    await FeatureFlagFactory.basic(auth, "frames_v2_drafts");

    const instructions = await framesSkill.fetchInstructions(auth, {
      spaceIds: [],
    });

    expect(instructions).toContain("## Draft mode");
    expect(instructions).toContain(
      "dsbx frame draft-mode /files/<scope>/<frame-folder>/manifest.json"
    );
    expect(instructions).toContain(
      "goes to a draft that only\nshows in the conversation's Frame panel"
    );
    expect(instructions).toContain(
      "which goes live unless the Frame is in draft mode"
    );
    expect(instructions).not.toContain("--draft");
    expect(instructions).toContain(
      "dsbx frame make-live /files/<scope>/<frame-folder>/manifest.json"
    );
    expect(instructions).toContain("the share link keeps serving the live");
    expect(instructions).toContain(
      "including edits the user saved in the panel"
    );
    expect(instructions).toContain("never say it is visible on the share link");
    expect(instructions).not.toContain("publicationId");
  });

  it("does not mention drafts without the drafts flag, even with functions", async () => {
    const { authenticator: auth } = await createResourceTest({});
    await FeatureFlagFactory.basic(auth, "frames_v2_functions");

    const instructions = await framesSkill.fetchInstructions(auth, {
      spaceIds: [],
    });

    expect(instructions).not.toMatch(/draft/i);
    expect(instructions).not.toContain("make-live");
    expect(instructions).toContain("records a publication and makes it live");
    expect(instructions).toContain(
      "do not parse the Frame ID from the CLI output"
    );
  });

  it("defaults Frames to the conversation in a Pod", async () => {
    const { authenticator: auth } = await createResourceTest({});

    const instructions = await framesSkill.fetchInstructions(auth, {
      spaceIds: [],
      agentLoopData: agentLoopDataInPod("vlt_abc123"),
    });

    expect(instructions).toContain(POD_V2_PLACEMENT_MARKER);
    expect(instructions).toContain("/files/pod-<podId>/<frame-folder>");
    expect(instructions).toContain("Frame's Save button");
  });

  it("omits Pod placement outside a Pod", async () => {
    const { authenticator: auth } = await createResourceTest({});

    const instructions = await framesSkill.fetchInstructions(auth, {
      spaceIds: [],
      agentLoopData: agentLoopDataInPod(null),
    });

    expect(instructions).not.toContain(POD_V2_PLACEMENT_MARKER);
    expect(instructions).not.toContain("/files/pod-<podId>/<frame-folder>");
  });
});
