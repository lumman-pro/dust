import { FrameRenderer } from "@app/components/assistant/conversation/interactive_content/FrameRenderer";
import { LightWorkspaceFactory } from "@app/tests/utils/LightWorkspaceFactory";
import type { ConversationWithoutContentType } from "@app/types/assistant/conversation";
import type { EditTextFn } from "@app/types/assistant/visualization";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  batchEditFrameText: vi.fn(),
  confirm: vi.fn(),
  editFrameText: vi.fn(),
  iframe: vi.fn(
    (_props: {
      frameId?: string;
      functionTarget?: string;
      isEditable?: boolean;
      stagedEditMode?: "preview" | "edit";
      onEditText?: EditTextFn;
      visualization?: { identifier: string };
    }) => null
  ),
  hasFrameFunctions: false,
  canWriteFrameSource: true,
  draftPublicationId: null as string | null,
  draftMode: false,
  draftsEnabled: false,
  enterDraftMode: vi.fn(async () => true),
  mutateFramePermissions: vi.fn(async () => undefined),
  isMobile: false,
  /** Incremented on every iframe mount (React key change). */
  iframeMounts: 0,
  mutateFileContent: vi.fn(),
  useFileContent: vi.fn(),
  useFramePermissions: vi.fn(),
}));

vi.mock(
  "@app/components/assistant/conversation/actions/AuthenticatedVisualizationActionIframe",
  async () => {
    const { forwardRef, useEffect } =
      await vi.importActual<typeof import("react")>("react");
    return {
      AuthenticatedVisualizationActionIframe: forwardRef((props, _ref) => {
        useEffect(() => {
          mocks.iframeMounts += 1;
        }, []);
        mocks.iframe(props);
        return null;
      }),
    };
  }
);

vi.mock(
  "@app/components/assistant/conversation/ConversationSidePanelContext",
  () => ({
    useConversationSidePanelContext: () => ({
      closePanel: vi.fn(),
      panelRef: null,
    }),
  })
);

vi.mock(
  "@app/components/assistant/conversation/ConversationSidePanelHeader",
  async () => {
    const { createElement } =
      await vi.importActual<typeof import("react")>("react");
    return {
      ConversationSidePanelHeader: ({ children }: { children?: ReactNode }) =>
        createElement("div", null, children),
    };
  }
);

vi.mock(
  "@app/components/assistant/conversation/interactive_content/ExportContentDropdown",
  () => ({ ExportContentDropdown: () => null })
);
vi.mock(
  "@app/components/assistant/conversation/interactive_content/frame/ShareFramePopover",
  () => ({ ShareFramePopover: () => null })
);
vi.mock("@app/components/pod/files/PinPodBannerButton", () => ({
  PinPodBannerButton: () => null,
}));
vi.mock("@app/components/pod/files/PodFileTabButton", () => ({
  PodFileTabButton: () => null,
}));
vi.mock("@app/components/navigation/DesktopNavigationContext", () => ({
  useDesktopNavigation: () => ({
    isNavigationBarOpen: true,
    setIsNavigationBarOpen: vi.fn(),
  }),
}));
vi.mock("@app/hooks/conversations", () => ({
  useVisualizationRevert: () => ({ handleVisualizationRevert: vi.fn() }),
}));
vi.mock("@app/hooks/useHashParams", () => ({
  useHashParam: () => [undefined, vi.fn()],
}));
vi.mock("@app/hooks/useNotification", () => ({
  useSendNotification: () => vi.fn(),
  useSendApiErrorNotification: () => vi.fn(),
}));
vi.mock("@app/lib/auth/AuthContext", () => ({
  useAuth: () => ({ vizUrl: "https://viz.dust.tt" }),
  useFeatureFlags: () => ({
    hasFeature: (feature: string) =>
      feature === "frames_v2_drafts" && mocks.draftsEnabled,
  }),
}));
vi.mock("@app/lib/context/clientType", () => ({
  useClientType: () => "web",
}));
vi.mock("@app/lib/swr/files", () => ({
  useFileContent: (args: unknown) => {
    mocks.useFileContent(args);
    return {
      fileContent: "export default function Frame() {}",
      error: null,
      isFileContentLoading: false,
      mutateFileContent: mocks.mutateFileContent,
    };
  },
  useFileContentByUrl: () => ({
    fileContent: "export default function FrameV2() {}",
    isNotFound: false,
    isFileContentLoading: false,
    fileContentError: null,
  }),
  useFileMetadata: () => ({
    fileMetadata: {
      fileName: "manifest.json",
      useCaseMetadata: {},
      version: 1,
    },
    mutateFileMetadata: vi.fn(),
  }),
  useShareInteractiveContentFile: () => ({
    fileShare: { shareUrl: "https://dust.tt/share/frame/share-token" },
  }),
}));
vi.mock("@app/components/Confirm", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    ConfirmContext: React.createContext(mocks.confirm),
  };
});

vi.mock("@app/hooks/useMakeFrameDraftLive", () => ({
  useMakeFrameDraftLive: () => async () => true,
}));
vi.mock("@app/hooks/useEnterFrameDraftMode", () => ({
  useEnterFrameDraftMode: () => mocks.enterDraftMode,
}));

vi.mock("@app/lib/swr/frames", () => ({
  useBatchEditFrameText: () => mocks.batchEditFrameText,
  useEditFrameText: () => mocks.editFrameText,
  useFramePermissions: (args: unknown) => {
    mocks.useFramePermissions(args);
    return {
      canWriteFrameSource: mocks.canWriteFrameSource,
      packageRoot: null,
      hasFrameFunctions: mocks.hasFrameFunctions,
      requiredTools: [],
      isLastPublisher: false,
      hasAuthorizedRequiredTools: true,
      hasFramePermissions: true,
      isFramePermissionsLoading: false,
      isFramePermissionsError: null,
      draftPublicationId: mocks.draftPublicationId,
      draftMode: mocks.draftMode,
      livePublicationId: "publication-live",
      livePublishedAt: null,
      mutateFramePermissions: mocks.mutateFramePermissions,
    };
  },
}));
vi.mock("@app/lib/swr/pods", () => ({
  usePodFiles: () => ({ files: [] }),
}));
vi.mock("@app/lib/swr/spaces", () => ({
  useSpaceInfo: () => ({ spaceInfo: null, isSpaceInfoLoading: false }),
}));
vi.mock("@app/lib/swr/useIsMobile", () => ({
  useIsMobile: () => mocks.isMobile,
}));

const owner = LightWorkspaceFactory.build({ sId: "workspace_1", role: "user" });

const conversation: ConversationWithoutContentType = {
  id: 1,
  sId: "conversation_1",
  title: "Conversation",
  depth: 0,
  actionRequired: false,
  created: 1,
  hasError: false,
  isRunningAgentLoop: false,
  isParticipant: true,
  lastReadMs: null,
  metadata: {},
  requestedSpaceIds: [],
  spaceId: null,
  triggerId: null,
  unread: false,
  updated: 1,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.hasFrameFunctions = false;
  mocks.canWriteFrameSource = true;
  mocks.draftPublicationId = null;
  mocks.draftMode = false;
  mocks.draftsEnabled = false;
  mocks.isMobile = false;
  mocks.iframeMounts = 0;
});

describe("FrameRenderer", () => {
  it("asks for the latest publication for the bundle, its functions and their presence", () => {
    render(
      <FrameRenderer
        conversation={conversation}
        fileId="frame_1"
        projectId={null}
        owner={owner}
        renderMode="v2"
      />
    );

    expect(mocks.useFileContent).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: "frame_1", publication: "latest" })
    );
    expect(mocks.useFramePermissions).toHaveBeenCalledWith(
      expect.objectContaining({ frameId: "frame_1", publication: "latest" })
    );
    expect(mocks.iframe).toHaveBeenCalledWith(
      expect.objectContaining({ functionTarget: "latest" })
    );
  });

  it("reloads the bundle it rendered", async () => {
    render(
      <FrameRenderer
        conversation={conversation}
        fileId="frame_1"
        projectId={null}
        owner={owner}
        renderMode="v2"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Reload the file" }));

    await waitFor(() => {
      expect(mocks.mutateFileContent).toHaveBeenCalledWith();
    });
  });

  it("shows the Frame v2 source when switching to code", async () => {
    const { container } = render(
      <FrameRenderer
        conversation={conversation}
        fileId="frame_1"
        projectId={null}
        owner={owner}
        renderMode="v2"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Switch to code" }));

    await waitFor(() => {
      expect(container).toHaveTextContent(
        "export default function FrameV2() {}"
      );
    });
    expect(
      screen.getByRole("button", { name: "Switch to rendering" })
    ).toBeInTheDocument();
  });

  it("keeps Frame v2 Preview without edit affordances until Edit is selected", () => {
    render(
      <FrameRenderer
        conversation={conversation}
        fileId="frame_1"
        projectId={null}
        owner={owner}
        renderMode="v2"
      />
    );

    // Iframe stays editable-capable so Preview↔Edit does not remount; Edit mode is off.
    expect(mocks.iframe).toHaveBeenCalledWith(
      expect.objectContaining({
        frameId: "frame_1",
        isEditable: true,
        stagedEditMode: "preview",
        onEditText: expect.any(Function),
      })
    );
    expect(screen.getByRole("tab", { name: "Preview" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tab", { name: "Edit" })).toBeInTheDocument();
  });

  it("enables inline editing after a source writer enters edit mode", () => {
    render(
      <FrameRenderer
        conversation={conversation}
        fileId="frame_1"
        projectId={null}
        owner={owner}
        renderMode="v2"
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));

    expect(mocks.iframe).toHaveBeenLastCalledWith(
      expect.objectContaining({
        frameId: "frame_1",
        isEditable: true,
        stagedEditMode: "edit",
        onEditText: expect.any(Function),
      })
    );
    expect(screen.getByRole("tab", { name: "Edit" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("hides the edit mode toggle when the viewer cannot edit the Frame source", () => {
    mocks.canWriteFrameSource = false;

    render(
      <FrameRenderer
        conversation={conversation}
        fileId="frame_1"
        projectId={null}
        owner={owner}
        renderMode="v2"
      />
    );

    expect(mocks.iframe).toHaveBeenCalledWith(
      expect.objectContaining({
        frameId: "frame_1",
        isEditable: false,
        onEditText: undefined,
      })
    );
    expect(screen.queryByRole("tab", { name: "Edit" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Switch to code" })
    ).not.toBeInTheDocument();
  });

  it("marks a Frame declaring functions as beta", () => {
    mocks.hasFrameFunctions = true;

    render(
      <FrameRenderer
        conversation={conversation}
        fileId="frame_1"
        projectId={null}
        owner={owner}
        renderMode="v2"
      />
    );

    const betaLink = screen.getByRole("link", { name: "Beta" });
    expect(betaLink).toHaveAttribute(
      "href",
      "https://app.dust.tt/share/frame/c5d83f0e-4825-4c6f-b33a-6841b1490d19"
    );
    expect(betaLink).toHaveAttribute("target", "_blank");
  });

  describe("draft controls", () => {
    // Radix menus measure their content, which jsdom cannot.
    beforeAll(() => {
      vi.stubGlobal(
        "ResizeObserver",
        class {
          observe() {}
          unobserve() {}
          disconnect() {}
        }
      );
    });

    const renderV2 = () =>
      render(
        <FrameRenderer
          conversation={conversation}
          fileId="frame_1"
          projectId={null}
          owner={owner}
          renderMode="v2"
        />
      );

    it("frames the panel and offers Validate draft to an editor in draft mode", () => {
      mocks.draftMode = true;

      renderV2();

      expect(screen.getByText("Draft")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Validate draft" })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "More actions" })
      ).not.toBeInTheDocument();
    });

    it("turns draft mode on from the more menu, then refreshes permissions", async () => {
      const user = userEvent.setup();
      mocks.draftsEnabled = true;

      renderV2();
      expect(screen.queryByText("Draft")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Validate draft" })
      ).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "More actions" }));
      await user.click(
        await screen.findByRole("menuitem", { name: "Activate draft mode" })
      );

      await waitFor(() =>
        expect(mocks.mutateFramePermissions).toHaveBeenCalledTimes(1)
      );
      expect(mocks.enterDraftMode).toHaveBeenCalledTimes(1);
    });

    it("offers no draft mode without the drafts feature", () => {
      renderV2();

      expect(
        screen.queryByRole("button", { name: "More actions" })
      ).not.toBeInTheDocument();
    });

    it("offers no draft mode to a viewer who cannot edit", () => {
      mocks.canWriteFrameSource = false;
      mocks.draftsEnabled = true;
      mocks.draftMode = true;

      renderV2();

      expect(screen.queryByText("Draft")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Validate draft" })
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "More actions" })
      ).not.toBeInTheDocument();
    });
  });

  it("does not mark a Frame without functions as beta", () => {
    render(
      <FrameRenderer
        conversation={conversation}
        fileId="frame_1"
        projectId={null}
        owner={owner}
        renderMode="v2"
      />
    );

    expect(screen.queryByText("Beta")).not.toBeInTheDocument();
  });

  it("opens the frame's share URL in a new tab", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    render(
      <FrameRenderer
        conversation={conversation}
        fileId="frame_1"
        projectId={null}
        owner={owner}
        contentHash="frame_1@42"
        renderMode="v2"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open in a new tab" }));

    expect(open).toHaveBeenCalledWith(
      "https://dust.tt/share/frame/share-token",
      "_blank",
      "noopener,noreferrer"
    );
  });

  it("remounts the viz iframe when contentHash changes", () => {
    const { rerender } = render(
      <FrameRenderer
        conversation={conversation}
        fileId="frame_1"
        projectId={null}
        owner={owner}
        contentHash="frame_1@42"
        renderMode="v2"
      />
    );

    // Identifier stays stable (avoids Next.js /content URL thrash); remount is
    // driven by React key which includes contentHash.
    expect(mocks.iframe.mock.calls.at(-1)?.[0].visualization?.identifier).toBe(
      "viz-frame_1"
    );
    expect(mocks.iframeMounts).toBe(1);

    rerender(
      <FrameRenderer
        conversation={conversation}
        fileId="frame_1"
        projectId={null}
        owner={owner}
        contentHash="frame_1@99"
        renderMode="v2"
      />
    );

    expect(mocks.iframe.mock.calls.at(-1)?.[0].visualization?.identifier).toBe(
      "viz-frame_1"
    );
    // New mount after contentHash change (React key includes contentHash).
    expect(mocks.iframeMounts).toBe(2);
  });

  it("does not remount the iframe when switching between Preview and Edit", () => {
    render(
      <FrameRenderer
        conversation={conversation}
        fileId="frame_1"
        projectId={null}
        owner={owner}
        renderMode="v2"
      />
    );

    expect(mocks.iframe.mock.calls.at(-1)?.[0]?.stagedEditMode).toBe("preview");
    expect(mocks.iframeMounts).toBe(1);

    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));

    expect(mocks.iframe.mock.calls.at(-1)?.[0]?.stagedEditMode).toBe("edit");
    expect(mocks.iframeMounts).toBe(1);

    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));

    expect(mocks.iframe.mock.calls.at(-1)?.[0]?.stagedEditMode).toBe("preview");
    expect(mocks.iframeMounts).toBe(1);
  });

  it("stages v2 edits without publishing until Save", async () => {
    mocks.batchEditFrameText.mockResolvedValue({ success: true });
    mocks.mutateFileContent.mockResolvedValue(
      "export default function Frame() { return <p>Done</p>; }"
    );

    render(
      <FrameRenderer
        conversation={conversation}
        fileId="frame_1"
        projectId={null}
        owner={owner}
        renderMode="v2"
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));

    const lastIframeProps = mocks.iframe.mock.calls.at(-1)?.[0];
    const onEditText = lastIframeProps?.onEditText;
    if (!onEditText) {
      throw new Error("Expected Frame v2 to be editable.");
    }

    await act(async () => {
      await onEditText({
        newText: "Done",
        oldText: "Ready",
        source: "index.tsx:1:42",
      });
      await onEditText({
        newText: "Two",
        oldText: "One",
        source: "index.tsx:2:1",
      });
    });

    expect(mocks.batchEditFrameText).not.toHaveBeenCalled();
    expect(mocks.editFrameText).not.toHaveBeenCalled();
    // Staging does not remount the iframe.
    expect(mocks.iframeMounts).toBe(1);

    const saveButton = screen.getByRole("button", { name: "Apply" });
    expect(saveButton).toBeEnabled();

    await act(async () => {
      fireEvent.click(saveButton);
    });

    await waitFor(() => {
      expect(mocks.batchEditFrameText).toHaveBeenCalledWith([
        {
          newText: "Done",
          oldText: "Ready",
          source: "index.tsx:1:42",
        },
        {
          newText: "Two",
          oldText: "One",
          source: "index.tsx:2:1",
        },
      ]);
    });

    // Save remounts on the published content (contentRevision in the React key) while
    // the viz identifier stays stable.
    await waitFor(() => {
      expect(mocks.iframeMounts).toBe(2);
      expect(
        mocks.iframe.mock.calls.at(-1)?.[0]?.visualization?.identifier
      ).toBe("viz-frame_1");
      expect(mocks.iframe.mock.calls.at(-1)?.[0]?.stagedEditMode).toBe(
        "preview"
      );
    });
    expect(mocks.mutateFileContent).toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "Preview" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("blocks interaction and shows publishing tooltip while Save is in flight", async () => {
    let resolveBatch: (value: { success: true }) => void = () => undefined;
    mocks.batchEditFrameText.mockImplementation(
      () =>
        new Promise<{ success: true }>((resolve) => {
          resolveBatch = resolve;
        })
    );

    render(
      <FrameRenderer
        conversation={conversation}
        fileId="frame_1"
        projectId={null}
        owner={owner}
        renderMode="v2"
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));

    const onEditText = mocks.iframe.mock.calls.at(-1)?.[0].onEditText;
    if (!onEditText) {
      throw new Error("Expected Frame v2 to be editable.");
    }

    await act(async () => {
      await onEditText({
        newText: "Done",
        oldText: "Ready",
        source: "index.tsx:1:42",
      });
    });

    const saveButton = screen.getByRole("button", { name: "Apply" });
    await act(async () => {
      fireEvent.click(saveButton);
    });

    expect(saveButton).toBeDisabled();
    expect(
      screen.getByLabelText("Publishing your changes...")
    ).toBeInTheDocument();

    await act(async () => {
      resolveBatch({ success: true });
    });

    await waitFor(() => {
      expect(
        screen.queryByLabelText("Publishing your changes...")
      ).not.toBeInTheDocument();
    });
  });

  it("saves both text nodes of one element instead of merging them", async () => {
    mocks.batchEditFrameText.mockResolvedValue({ success: true });

    render(
      <FrameRenderer
        conversation={conversation}
        fileId="frame_1"
        projectId={null}
        owner={owner}
        renderMode="v2"
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    const onEditText = mocks.iframe.mock.calls.at(-1)?.[0].onEditText;
    if (!onEditText) {
      throw new Error("Expected Frame v2 to be editable.");
    }

    // `<p>Hello <b>x</b> world</p>`: both text nodes resolve to the `<p>` source.
    await act(async () => {
      await onEditText({
        oldText: "Hello",
        newText: "Hi",
        source: "index.tsx:1:1",
      });
      await onEditText({
        oldText: "world",
        newText: "there",
        source: "index.tsx:1:1",
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    });

    await waitFor(() => {
      expect(mocks.batchEditFrameText).toHaveBeenCalledWith([
        { oldText: "Hello", newText: "Hi", source: "index.tsx:1:1" },
        { oldText: "world", newText: "there", source: "index.tsx:1:1" },
      ]);
    });
  });

  it("publishes legacy Frame edits immediately without Preview|Edit or Save", async () => {
    mocks.editFrameText.mockResolvedValue({ success: true });
    mocks.mutateFileContent.mockResolvedValue(
      "export default function Frame() { return <p>Done</p>; }"
    );

    render(
      <FrameRenderer
        conversation={conversation}
        fileId="frame_1"
        projectId={null}
        owner={owner}
        renderMode="legacy"
      />
    );

    expect(screen.queryByRole("tab", { name: "Edit" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Apply" })
    ).not.toBeInTheDocument();

    expect(mocks.iframe).toHaveBeenCalledWith(
      expect.objectContaining({
        isEditable: true,
        stagedEditMode: undefined,
        onEditText: expect.any(Function),
      })
    );

    const onEditText = mocks.iframe.mock.calls.at(-1)?.[0].onEditText;
    if (!onEditText) {
      throw new Error("Expected legacy Frame to be editable.");
    }

    await act(async () => {
      await onEditText({
        newText: "Done",
        oldText: "Ready",
        source: "index.tsx:1:42",
      });
    });

    expect(mocks.editFrameText).toHaveBeenCalledWith({
      newText: "Done",
      oldText: "Ready",
      source: "index.tsx:1:42",
    });
    expect(mocks.batchEditFrameText).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(mocks.mutateFileContent).toHaveBeenCalled();
    });
    // Legacy keeps a stable instance id — no remount after edit (same as main).
    expect(mocks.iframe.mock.calls.at(-1)?.[0]?.visualization?.identifier).toBe(
      "viz-frame_1"
    );
  });

  it("keeps the v2 Save control identifiable when labels are hidden on mobile", async () => {
    mocks.isMobile = true;

    render(
      <FrameRenderer
        conversation={conversation}
        fileId="frame_1"
        projectId={null}
        owner={owner}
        renderMode="v2"
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));

    const saveButton = screen.getByRole("button", { name: "Apply" });
    expect(saveButton).toBeDisabled();
    // Icon-only on mobile: still an accessible name, and not an empty control.
    expect(saveButton.querySelector("svg")).not.toBeNull();
  });

  it("asks to discard unsaved v2 edits when leaving Edit", async () => {
    mocks.confirm.mockResolvedValue(false);

    render(
      <FrameRenderer
        conversation={conversation}
        fileId="frame_1"
        projectId={null}
        owner={owner}
        renderMode="v2"
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));

    const onEditText = mocks.iframe.mock.calls.at(-1)?.[0].onEditText;
    if (!onEditText) {
      throw new Error("Expected Frame v2 to be editable.");
    }

    await act(async () => {
      await onEditText({
        newText: "Done",
        oldText: "Ready",
        source: "index.tsx:1:42",
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    });

    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        validateLabel: "Discard",
      })
    );
    // Cancel keeps Edit mode.
    expect(screen.getByRole("tab", { name: "Edit" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    mocks.confirm.mockResolvedValue(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    });

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Preview" })).toHaveAttribute(
        "aria-selected",
        "true"
      );
    });
    expect(mocks.batchEditFrameText).not.toHaveBeenCalled();
  });
});
