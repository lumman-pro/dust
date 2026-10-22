import { isToolGeneratedFilePath } from "@app/lib/actions/mcp_internal_actions/output_schemas";
import type { ToolContext } from "@app/lib/actions/types";
import { uploadAndFormatImageResponse } from "@app/lib/api/actions/servers/image_generation/helpers";
import { InternalMCPServerInMemoryResource } from "@app/lib/resources/internal_mcp_server_in_memory_resource";
import { MCPServerViewFactory } from "@app/tests/utils/MCPServerViewFactory";
import { fileStorageMock } from "@app/tests/utils/mocks/file_storage";
import { SandboxFunctionMCPActionFactory } from "@app/tests/utils/SandboxFunctionMCPActionFactory";
import { createPersistedSandboxFunctionInvocationTokenTestContext } from "@app/tests/utils/SandboxTokenFactory";
import { getFramePersistentFilesBasePath } from "@app/types/api/frame_storage";
import { getFramePersistentFilesMountPoint } from "@app/types/mount_path";
import assert from "assert";
import { describe, expect, it } from "vitest";

describe("uploadAndFormatImageResponse", () => {
  it("writes generated images to the Frame persistent files folder", async () => {
    const {
      auth,
      workspace,
      invocation,
      globalSpace,
      podSpace,
      sandboxFunction,
    } = await createPersistedSandboxFunctionInvocationTokenTestContext();
    const frame = sandboxFunction.frame;
    const server = await InternalMCPServerInMemoryResource.makeNew(auth, {
      name: "common_utilities",
      useCase: null,
    });
    const view = await MCPServerViewFactory.create(
      workspace,
      server.id,
      globalSpace
    );
    const action = await SandboxFunctionMCPActionFactory.create(auth, {
      invocation,
      mcpServerView: view,
    });
    const toolContext: ToolContext = {
      runContext: {
        contextType: "sandbox_function",
        action,
        invocation,
        pod: podSpace,
        toolConfiguration: action.toolConfiguration,
      },
    };

    fileStorageMock.reset();
    const imageContent = Buffer.from("generated image bytes");
    const result = await uploadAndFormatImageResponse(
      auth,
      toolContext,
      [
        {
          base64: `data:image/png;base64,${imageContent.toString("base64")}`,
          mimeType: "image/png",
        },
      ],
      "generated-image.png"
    );

    assert(result.isOk());
    assert(!Array.isArray(result.value));
    const { content, structuredContent } = result.value;
    expect(content).toHaveLength(1);
    const fileOutput = content.find(isToolGeneratedFilePath);
    assert(fileOutput);

    const sandboxPathPrefix = `${getFramePersistentFilesMountPoint(frame.sId)}/.tool_outputs/${sandboxFunction.slug}/`;
    expect(fileOutput.resource.path).toBe(fileOutput.resource.uri);
    expect(fileOutput.resource.path).toBe(
      `${sandboxPathPrefix}${fileOutput.resource.title}`
    );
    expect(fileOutput.resource.title).toMatch(/^\d+_generated_image\.png$/);
    expect(fileOutput.resource.contentType).toBe("image/png");

    expect(structuredContent).toEqual({
      files: [
        {
          path: fileOutput.resource.path,
          title: fileOutput.resource.title,
          contentType: "image/png",
        },
      ],
      hint: `Read with node:fs/promises: await readFile(${JSON.stringify(fileOutput.resource.path)}). Do not pass this path to useFile().`,
    });

    expect(fileStorageMock.saveFileCalls).toHaveLength(1);
    const fileWrite = fileStorageMock.saveFileCalls[0];
    const relativePath = fileOutput.resource.path.slice(
      `${getFramePersistentFilesMountPoint(frame.sId)}/`.length
    );
    expect(fileWrite.filePath).toBe(
      `${getFramePersistentFilesBasePath({
        workspaceId: workspace.sId,
        frameId: frame.sId,
      })}${relativePath}`
    );
    expect(fileWrite.content).toEqual(imageContent);
    expect(fileWrite.contentType).toBe("image/png");
  });
});
