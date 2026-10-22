import { useSidePanelFrameTracking } from "@app/components/assistant/conversation/interactive_content/useFrameTracking";
import { PodFramePanel } from "@app/components/pod/files/PodFramePanel";
import { FileSystemEntryFactory } from "@app/tests/utils/FileSystemEntryFactory";
import { LightWorkspaceFactory } from "@app/tests/utils/LightWorkspaceFactory";
import type { FileSystemEntry } from "@app/types/api/file_system/types";
import type { PodType } from "@app/types/space";
import { cleanup, render, screen } from "@testing-library/react";
import type { PropsWithChildren, ReactNode } from "react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const frameV2Metadata = {
  contentType: "application/vnd.dust.frame.v2+json",
  fileName: "manifest.json",
  useCaseMetadata: { spaceId: "vlt_project" },
};

interface Mocks {
  canWriteFrameSource: boolean;
  hasAuthorizedRequiredTools: boolean;
  contentCalls: Record<string, unknown>[];
  draftMode: boolean;
  fileMetadata: Record<string, unknown>;
  hasFrameFunctions: boolean;
  iframeProps: {
    frameId?: string;
    functionTarget?: string;
    isEditable?: boolean;
    stagedEditMode?: string;
  } | null;
  metadataCalls: { disabled?: boolean; fileId: string | null }[];
  podActions: { fileName?: string; framePath: string | null } | null;
  permissionsCalls: { disabled?: boolean; frameId: string }[];
  podFiles: FileSystemEntry[];
  isPodFilesLoading: boolean;
}

const mocks = vi.hoisted<Mocks>(() => ({
  canWriteFrameSource: true,
  hasAuthorizedRequiredTools: true,
  contentCalls: [],
  draftMode: false,
  fileMetadata: {},
  hasFrameFunctions: false,
  iframeProps: null,
  metadataCalls: [],
  podActions: null,
  permissionsCalls: [],
  podFiles: [],
  isPodFilesLoading: false,
}));

vi.mock(
  "@app/components/assistant/conversation/actions/AuthenticatedVisualizationActionIframe",
  async () => {
    const { forwardRef } = await import("react");
    return {
      AuthenticatedVisualizationActionIframe: forwardRef<
        HTMLIFrameElement,
        {
          frameId?: string;
          isEditable?: boolean;
          stagedEditMode?: string;
        }
      >(function AuthenticatedVisualizationActionIframe(props, _ref) {
        mocks.iframeProps = props;
        return "frame-iframe";
      }),
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

vi.mock(
  "@app/components/assistant/conversation/interactive_content/frame/FrameEditControls",
  () => ({
    FrameEditControls: () => createElement("div", null, "edit-controls"),
  })
);

vi.mock(
  "@app/components/assistant/conversation/interactive_content/frame/FrameToolConsentGate",
  () => ({
    FrameToolConsentGate: () => createElement("div", null, "tool-consent-gate"),
  })
);

interface PinPodBannerButtonMockProps {
  fileName?: string;
  framePath: string | null;
}

vi.mock("@app/components/pod/files/PinPodBannerButton", () => ({
  PinPodBannerButton: (props: PinPodBannerButtonMockProps) => {
    mocks.podActions = props;
    return null;
  },
}));

vi.mock(
  "@app/components/assistant/conversation/ConversationSidePanelHeader",
  () => ({
    ConversationSidePanelHeader: ({ children }: PropsWithChildren) =>
      createElement("div", null, children),
  })
);

vi.mock(
  "@app/components/assistant/conversation/interactive_content/useFrameTracking",
  () => ({ useSidePanelFrameTracking: vi.fn() })
);

vi.mock(
  "@app/components/assistant/conversation/useSidePanelFullScreen",
  () => ({
    useSidePanelFullScreen: () => ({
      canEnterFullScreen: true,
      closePanel: vi.fn(),
      enterFullScreen: vi.fn(),
      exitFullScreen: vi.fn(),
      isFullScreen: false,
    }),
  })
);

vi.mock("@app/lib/swr/pods", () => ({
  usePodFiles: () => ({
    files: mocks.podFiles,
    isPodFilesLoading: mocks.isPodFilesLoading,
  }),
}));

vi.mock("@app/components/pod/files/PodFileTabButton", () => ({
  PodFileTabButton: () => null,
}));

vi.mock(
  "@app/components/assistant/conversation/interactive_content/frame/useFrameEditSession",
  () => ({
    useFrameEditSession: () => ({
      contentRevision: 0,
      hasPendingEdits: false,
      isSaving: false,
      mode: "preview",
      remount: vi.fn(),
      save: vi.fn(),
      setMode: vi.fn(),
      stageEdit: vi.fn(),
    }),
  })
);

vi.mock("@app/lib/auth/AuthContext", () => ({
  useAuth: () => ({ vizUrl: "https://viz.dust.tt" }),
  useFeatureFlags: () => ({ hasFeature: () => false }),
}));

vi.mock("@app/lib/context/clientType", () => ({
  useClientType: () => "web",
}));

vi.mock("@app/lib/swr/files", () => ({
  useFileContent: (args: Record<string, unknown>) => {
    mocks.contentCalls.push(args);
    return { fileContent: "frame bundle", mutateFileContent: vi.fn() };
  },
  useFileContentByUrl: () => ({
    fileContent: "export default function Frame() {}",
    isNotFound: false,
    isFileContentLoading: false,
    fileContentError: null,
  }),
  useFileMetadata: (args: { disabled?: boolean; fileId: string | null }) => {
    mocks.metadataCalls.push(args);
    return {
      fileMetadata: mocks.fileMetadata,
      isFileMetadataError: null,
      isFileMetadataLoading: false,
    };
  },
  useShareInteractiveContentFile: () => ({
    fileShare: { shareUrl: "https://dust.tt/share/frame/token" },
  }),
}));

vi.mock("@app/lib/swr/frames", () => ({
  useFramePermissions: (args: { disabled?: boolean; frameId: string }) => {
    mocks.permissionsCalls.push(args);
    return {
      canWriteFrameSource: mocks.canWriteFrameSource,
      draftMode: mocks.draftMode,
      hasFrameFunctions: mocks.hasFrameFunctions,
      requiredTools: [],
      isLastPublisher: false,
      hasAuthorizedRequiredTools: mocks.hasAuthorizedRequiredTools,
      isFramePermissionsLoading: false,
      packageRoot: null,
      mutateFramePermissions: vi.fn(),
    };
  },
}));

vi.mock("@app/lib/swr/useIsMobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("@dust-tt/sparkle", async () => {
  const { createElement } = await import("react");
  const Empty = () => null;

  return {
    Button: ({
      children,
      "aria-label": ariaLabel,
      tooltip,
      onClick,
    }: {
      children?: ReactNode;
      "aria-label"?: string;
      tooltip?: string;
      onClick?: () => void;
    }) =>
      createElement(
        "button",
        { "aria-label": ariaLabel ?? tooltip, onClick },
        children
      ),
    Chip: ({ label }: { label?: string }) => createElement("div", null, label),
    CodeBlock: ({ children }: PropsWithChildren) =>
      createElement("pre", null, children),
    Eye: Empty,
    LinkExternal01: Empty,
    Maximize01: Empty,
    Minimize01: Empty,
    RefreshCw01: Empty,
    ReverseLeft: Empty,
    Spinner: Empty,
    Terminal: Empty,
    Tooltip: ({ label, trigger }: { label?: ReactNode; trigger: ReactNode }) =>
      createElement("div", null, trigger, label),
    XClose: Empty,
    cn: (...classes: Array<string | false | null | undefined>) =>
      classes.filter(Boolean).join(" "),
  };
});

const owner = LightWorkspaceFactory.build();

const pod: PodType = {
  archivedAt: null,
  createdAt: 0,
  description: null,
  groupIds: [],
  isEditor: true,
  isMember: true,
  isRestricted: false,
  kind: "project",
  name: "Project",
  sId: "vlt_project",
  updatedAt: 0,
};

beforeEach(() => {
  mocks.fileMetadata = { ...frameV2Metadata };
  mocks.podFiles = [
    FileSystemEntryFactory.file({
      fileId: "fil_frame",
      path: "pod-vlt_project/App/manifest.json",
    }),
  ];
  mocks.isPodFilesLoading = false;
  mocks.hasFrameFunctions = false;
  mocks.canWriteFrameSource = true;
  mocks.hasAuthorizedRequiredTools = true;
  mocks.draftMode = false;
});

afterEach(() => {
  cleanup();
  vi.mocked(useSidePanelFrameTracking).mockClear();
  mocks.iframeProps = null;
  mocks.contentCalls = [];
  mocks.metadataCalls = [];
  mocks.podActions = null;
  mocks.permissionsCalls = [];
});

const panelProps = {
  fileId: "fil_frame",
  owner,
  pod,
};

describe("PodFramePanel", () => {
  it("tracks the Frame as opened from the Pod's files", () => {
    render(createElement(PodFramePanel, panelProps));

    expect(useSidePanelFrameTracking).toHaveBeenCalledWith({
      frameId: "fil_frame",
      location: { type: "pod", id: "vlt_project" },
      uiElement: "pod_files",
      isFullScreen: false,
      canEnterFullScreen: true,
    });
  });

  it("names a Frame v2 after the folder holding its manifest", () => {
    render(createElement(PodFramePanel, panelProps));

    expect(mocks.podActions).toMatchObject({
      fileName: "App",
      framePath: "pod-vlt_project/App/manifest.json",
    });
  });

  it("names a legacy Frame, which has no manifest, after its file", () => {
    mocks.fileMetadata = {
      contentType: "text/vnd.dust.attachment.slack.thread",
      fileName: "Legacy.tsx",
      useCaseMetadata: { spaceId: "vlt_project" },
    };
    mocks.podFiles = [
      FileSystemEntryFactory.file({
        fileId: "fil_frame",
        path: "pod-vlt_project/Legacy.tsx",
      }),
    ];

    render(createElement(PodFramePanel, panelProps));

    expect(mocks.podActions).toMatchObject({ fileName: "Legacy.tsx" });
  });

  it("holds a Frames v2 behind tool consent until its tools are authorized", () => {
    mocks.hasAuthorizedRequiredTools = false;

    render(createElement(PodFramePanel, panelProps));

    expect(screen.getByText("tool-consent-gate")).toBeInTheDocument();
    expect(mocks.iframeProps).toBeNull();
  });

  it("waits for the Pod listing before rendering the Frame", () => {
    mocks.isPodFilesLoading = true;

    render(createElement(PodFramePanel, panelProps));

    expect(mocks.iframeProps).toBeNull();
  });

  it("marks a Frame declaring functions as beta", () => {
    mocks.hasFrameFunctions = true;

    render(createElement(PodFramePanel, panelProps));

    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("does not mark a Frame without functions as beta", () => {
    render(createElement(PodFramePanel, panelProps));

    expect(screen.queryByText("Beta")).not.toBeInTheDocument();
  });

  it("asks for Frame permissions only for a Frames v2", () => {
    const { rerender } = render(createElement(PodFramePanel, panelProps));

    expect(mocks.permissionsCalls.at(-1)).toMatchObject({
      disabled: false,
      frameId: "fil_frame",
    });

    mocks.fileMetadata = {
      contentType: "text/vnd.dust.attachment.slack.thread",
      fileName: "Legacy.tsx",
      useCaseMetadata: { spaceId: "vlt_project" },
    };
    rerender(createElement(PodFramePanel, panelProps));

    expect(mocks.permissionsCalls.at(-1)).toMatchObject({ disabled: true });
  });

  it("forwards the Frames v2 identity and package root", () => {
    render(createElement(PodFramePanel, panelProps));

    expect(mocks.iframeProps).toMatchObject({
      frameId: "fil_frame",
      framePackageRoot: "pod-vlt_project/App",
      isEditable: true,
      stagedEditMode: "preview",
    });
  });

  it("shows edit controls for a source writer and hides them for other viewers", () => {
    const { rerender } = render(createElement(PodFramePanel, panelProps));

    expect(screen.getByText("edit-controls")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Switch to code" })
    ).toBeInTheDocument();

    mocks.canWriteFrameSource = false;
    rerender(createElement(PodFramePanel, panelProps));

    expect(screen.queryByText("edit-controls")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Switch to code" })
    ).not.toBeInTheDocument();
    expect(mocks.iframeProps).toMatchObject({
      isEditable: false,
    });
  });

  it("offers no editing in draft mode and points writers to the conversation", () => {
    mocks.draftMode = true;

    render(createElement(PodFramePanel, panelProps));

    expect(screen.queryByText("edit-controls")).not.toBeInTheDocument();
    expect(screen.getByText("Draft mode")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This Frame is in draft mode. Edit it from the conversation."
      )
    ).toBeInTheDocument();
    expect(mocks.iframeProps).toMatchObject({ isEditable: false });
    expect(mocks.iframeProps).toMatchObject({ stagedEditMode: undefined });
    expect(
      screen.getByRole("button", { name: "Switch to code" })
    ).toBeInTheDocument();
  });

  it("shows no draft note to a viewer who cannot write the Frame source", () => {
    mocks.canWriteFrameSource = false;

    render(createElement(PodFramePanel, panelProps));

    expect(screen.queryByText("Draft mode")).not.toBeInTheDocument();
    expect(screen.queryByText("edit-controls")).not.toBeInTheDocument();
  });

  it("shows no draft note to a writer outside draft mode", () => {
    render(createElement(PodFramePanel, panelProps));

    expect(screen.queryByText("Draft mode")).not.toBeInTheDocument();
  });

  it("serves the live publication: no latest bundle, functions or function target", () => {
    render(createElement(PodFramePanel, panelProps));

    expect(mocks.contentCalls.at(-1)).not.toHaveProperty("publication");
    expect(mocks.permissionsCalls.at(-1)).not.toHaveProperty("publication");
    expect(mocks.iframeProps).not.toHaveProperty("functionTarget");
  });
});
