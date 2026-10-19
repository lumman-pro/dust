import { DocumentFrameEmbed } from "@app/components/file_explorer/DocumentFrameEmbed";
import { PodFrameVisualization } from "@app/components/pod/PodFrameVisualization";
import { usePodFrameRenderableContent } from "@app/hooks/usePodFrameRenderableContent";
import type { AuthContextValue } from "@app/lib/auth/AuthContext";
import { AuthContext } from "@app/lib/auth/AuthContext";
import type { FrameEmbedSource } from "@app/lib/markdown/frame_embed";
import { useFileContent, useFileMetadata } from "@app/lib/swr/files";
import { useFramePermissions } from "@app/lib/swr/frames";
import { useSpaceInfo } from "@app/lib/swr/spaces";
import { frameContentType, frameV2ContentType } from "@app/types/files";
import type { LightWorkspaceType } from "@app/types/user";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/components/pod/PodFrameVisualization", () => ({
  PodFrameVisualization: vi.fn(() => null),
}));
vi.mock("@app/hooks/usePodFrameRenderableContent", () => ({
  usePodFrameRenderableContent: vi.fn(),
}));
vi.mock("@app/lib/swr/spaces", () => ({
  useSpaceInfo: vi.fn(),
}));
vi.mock("@app/lib/swr/files", () => ({
  useFileMetadata: vi.fn(),
  useFileContent: vi.fn(),
}));
vi.mock("@app/lib/swr/frames", () => ({
  useFramePermissions: vi.fn(),
}));

const owner = { sId: "w_1" } as LightWorkspaceType;
const AUTH = { vizUrl: "https://viz.dust.tt" } as AuthContextValue;

const FRAME_FILE_ID = "fil_Q8Ac4uf35L";

const renderEmbed = (pathOrSource: string | FrameEmbedSource) =>
  render(
    <AuthContext.Provider value={AUTH}>
      <DocumentFrameEmbed
        owner={owner}
        source={
          typeof pathOrSource === "string"
            ? { kind: "file_path", path: pathOrSource }
            : pathOrSource
        }
        height={600}
        frameProps={{ region: "EU" }}
      />
    </AuthContext.Provider>
  );

describe("DocumentFrameEmbed", () => {
  beforeEach(() => {
    vi.mocked(usePodFrameRenderableContent).mockReturnValue({
      fileId: "fil_frame",
      fileContent: "export default function Frame() {}",
      fileContentType: frameV2ContentType,
      isLoading: false,
      isNotFound: false,
      error: null,
    });
    vi.mocked(useSpaceInfo).mockReturnValue({
      spaceInfo: null,
      isSpaceInfoLoading: false,
    } as unknown as ReturnType<typeof useSpaceInfo>);
  });

  it("renders a pod's Frame with the reader's roles in that pod", () => {
    vi.mocked(useSpaceInfo).mockReturnValue({
      spaceInfo: { isEditor: true, isMember: true },
      isSpaceInfoLoading: false,
    } as unknown as ReturnType<typeof useSpaceInfo>);

    renderEmbed("pod-spc_pod/dashboards/revenue.frame.json");

    expect(useSpaceInfo).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "w_1", spaceId: "spc_pod" })
    );
    expect(PodFrameVisualization).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: "spc_pod",
        conversationId: null,
        isPodEditor: true,
        isPodMember: true,
        frameId: "fil_frame",
        framePath: "pod-spc_pod/dashboards/revenue.frame.json",
        frameProps: { region: "EU" },
      }),
      expect.anything()
    );
  });

  it("renders a conversation's Frame without looking up a pod", () => {
    renderEmbed("conversation-c1/chart.frame.json");

    expect(useSpaceInfo).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: null, disabled: true })
    );
    expect(PodFrameVisualization).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: undefined,
        conversationId: "c1",
        isPodEditor: undefined,
        isPodMember: undefined,
      }),
      expect.anything()
    );
  });

  it("gives each embed of the same Frame its own identifier", () => {
    const source = {
      kind: "file_path" as const,
      path: "pod-spc_pod/dashboards/revenue.frame.json",
    };
    render(
      <AuthContext.Provider value={AUTH}>
        <DocumentFrameEmbed
          owner={owner}
          source={source}
          height={600}
          frameProps={{ region: "EU" }}
        />
        <DocumentFrameEmbed
          owner={owner}
          source={source}
          height={600}
          frameProps={{ region: "US" }}
        />
      </AuthContext.Provider>
    );

    const identifiers = vi
      .mocked(PodFrameVisualization)
      .mock.calls.map(([props]) => props.identifier);
    expect(new Set(identifiers).size).toBe(2);
  });

  it("waits for the reader's pod roles before rendering the Frame", () => {
    vi.mocked(useSpaceInfo).mockReturnValue({
      spaceInfo: null,
      isSpaceInfoLoading: true,
    } as unknown as ReturnType<typeof useSpaceInfo>);

    renderEmbed("pod-spc_pod/dashboards/revenue.frame.json");

    expect(PodFrameVisualization).not.toHaveBeenCalled();
  });

  it("shows the path of a file that is not a Frame", () => {
    vi.mocked(usePodFrameRenderableContent).mockReturnValue({
      fileId: "fil_doc",
      fileContent: "# Doc",
      fileContentType: "text/markdown",
      isLoading: false,
      isNotFound: false,
      error: null,
    });

    renderEmbed("pod-spc_pod/notes.md");

    expect(screen.getByText("pod-spc_pod/notes.md")).toBeDefined();
    expect(PodFrameVisualization).not.toHaveBeenCalled();
  });

  describe("by file id", () => {
    const mockFile = ({
      contentType,
      useCaseMetadata,
    }: {
      contentType: string;
      useCaseMetadata: { conversationId?: string; spaceId?: string };
    }) => {
      vi.mocked(useFileMetadata).mockReturnValue({
        fileMetadata: { contentType, useCaseMetadata },
        isFileMetadataLoading: false,
        isFileMetadataError: undefined,
      } as unknown as ReturnType<typeof useFileMetadata>);
      vi.mocked(useFileContent).mockReturnValue({
        fileContent: "export default function Frame() {}",
        isFileContentLoading: false,
        error: null,
      } as unknown as ReturnType<typeof useFileContent>);
    };

    beforeEach(() => {
      vi.mocked(useFramePermissions).mockReturnValue({
        packageRoot: "pod-spc_pod/dashboards",
        isFramePermissionsLoading: false,
      } as unknown as ReturnType<typeof useFramePermissions>);
    });

    it("renders a pod's v2 Frame in its pod, from its package directory", () => {
      mockFile({
        contentType: frameV2ContentType,
        useCaseMetadata: { spaceId: "spc_pod" },
      });

      renderEmbed({ kind: "file_id", fileId: FRAME_FILE_ID });

      expect(useFileMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: FRAME_FILE_ID })
      );
      expect(PodFrameVisualization).toHaveBeenCalledWith(
        expect.objectContaining({
          spaceId: "spc_pod",
          conversationId: null,
          frameId: FRAME_FILE_ID,
          framePath: null,
          framePackageRoot: "pod-spc_pod/dashboards",
          frameProps: { region: "EU" },
        }),
        expect.anything()
      );
    });

    it("renders a conversation's legacy Frame in its conversation", () => {
      mockFile({
        contentType: frameContentType,
        useCaseMetadata: { conversationId: "c1", spaceId: "spc_pod" },
      });

      renderEmbed({ kind: "file_id", fileId: FRAME_FILE_ID });

      expect(useFramePermissions).toHaveBeenCalledWith(
        expect.objectContaining({ disabled: true })
      );
      expect(PodFrameVisualization).toHaveBeenCalledWith(
        expect.objectContaining({
          spaceId: undefined,
          conversationId: "c1",
          frameId: undefined,
          framePackageRoot: null,
        }),
        expect.anything()
      );
    });

    it("waits for a v2 Frame's package directory before rendering it", () => {
      mockFile({
        contentType: frameV2ContentType,
        useCaseMetadata: { spaceId: "spc_pod" },
      });
      vi.mocked(useFramePermissions).mockReturnValue({
        packageRoot: null,
        isFramePermissionsLoading: true,
      } as unknown as ReturnType<typeof useFramePermissions>);

      renderEmbed({ kind: "file_id", fileId: FRAME_FILE_ID });

      expect(PodFrameVisualization).not.toHaveBeenCalled();
    });

    it("shows the file id of a file that is not a Frame", () => {
      mockFile({
        contentType: "text/markdown",
        useCaseMetadata: { spaceId: "spc_pod" },
      });

      renderEmbed({ kind: "file_id", fileId: FRAME_FILE_ID });

      expect(useFileContent).toHaveBeenCalledWith(
        expect.objectContaining({ config: { disabled: true } })
      );
      expect(screen.getByText(FRAME_FILE_ID)).toBeDefined();
      expect(PodFrameVisualization).not.toHaveBeenCalled();
    });
  });
});
