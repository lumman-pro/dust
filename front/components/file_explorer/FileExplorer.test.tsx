import { FileExplorer } from "@app/components/file_explorer/FileExplorer";
import type { ContentNodeEntry } from "@app/components/file_explorer/types";
import type { FileSystemFileEntry } from "@app/types/api/file_system/types";
import { frameV2ContentType } from "@app/types/files";
import { Ok } from "@app/types/shared/result";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { useState } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("@app/lib/swr/useIsMobile", () => ({
  useIsMobile: () => false,
}));

function makeFile({
  contentType,
  fileName,
  fileResourceContentType,
  lastModifiedMs,
  path = fileName,
}: {
  contentType: string;
  fileName: string;
  fileResourceContentType?: string;
  lastModifiedMs: number;
  path?: string;
}): FileSystemFileEntry {
  return {
    isDirectory: false,
    fileName,
    path: `conversation-c1/${path}`,
    contentType,
    fileId: `file-${fileName}`,
    fileResourceContentType,
    sizeBytes: 100,
    lastModifiedMs,
    thumbnailUrl: null,
  };
}

type ControlledFileExplorerProps = Omit<
  ComponentProps<typeof FileExplorer>,
  "currentFolderPath" | "onCurrentFolderChange" | "onOpenInPanel"
> &
  Partial<Pick<ComponentProps<typeof FileExplorer>, "onOpenInPanel">>;

// `FileExplorer` is a controlled component: folder navigation lives in the
// parent (in the app, in the URL). Tests hold it in local state.
function ControlledFileExplorer({
  onOpenInPanel = vi.fn(),
  ...props
}: ControlledFileExplorerProps) {
  const [currentFolderPath, setCurrentFolderPath] = useState("");

  return (
    <FileExplorer
      {...props}
      onOpenInPanel={onOpenInPanel}
      currentFolderPath={currentFolderPath}
      onCurrentFolderChange={setCurrentFolderPath}
    />
  );
}

// Layout and sort preferences persist in localStorage.
beforeEach(() => {
  localStorage.clear();
});

beforeAll(() => {
  // Radix relies on this browser API when opening dropdown content.
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe("FileExplorer file opening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("downloads binary files instead of opening the panel", async () => {
    const archive = makeFile({
      contentType: "application/zip",
      fileName: "archive.zip",
      lastModifiedMs: 1,
    });
    let finishDownload: (() => void) | undefined;
    const onDownload = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDownload = resolve;
        })
    );
    const onOpenInPanel = vi.fn();

    render(
      <ControlledFileExplorer
        defaultViewMode="list"
        files={[archive]}
        isLoading={false}
        onDownload={onDownload}
        onOpenInPanel={onOpenInPanel}
      />
    );

    const archiveTitle = screen.getByText("archive.zip");
    fireEvent.click(archiveTitle);

    await waitFor(() =>
      expect(onDownload).toHaveBeenCalledWith({
        ...archive,
        kind: "file",
      })
    );
    expect(archiveTitle.closest("[aria-busy]")).toHaveAttribute(
      "aria-busy",
      "true"
    );
    fireEvent.click(archiveTitle);
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onOpenInPanel).not.toHaveBeenCalled();

    finishDownload?.();
    await waitFor(() =>
      expect(archiveTitle.closest("[aria-busy]")).toHaveAttribute(
        "aria-busy",
        "false"
      )
    );
  });
});

describe("FileExplorer navigation", () => {
  it("resets the type filter when opening a folder", () => {
    const nestedFile = makeFile({
      contentType: "text/plain",
      fileName: "nested.txt",
      lastModifiedMs: 1,
      path: "folder/nested.txt",
    });
    const rootFile = makeFile({
      contentType: "text/plain",
      fileName: "root.txt",
      lastModifiedMs: 1,
    });

    render(
      <ControlledFileExplorer
        defaultViewMode="list"
        files={[nestedFile, rootFile]}
        isLoading={false}
        onDownload={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Folders" }));
    fireEvent.click(screen.getByText("folder"));

    expect(screen.getByText("nested.txt")).toBeInTheDocument();
  });

  it("passes a folder's canonical path to folder actions", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    const nestedFile = makeFile({
      contentType: "text/plain",
      fileName: "nested.txt",
      lastModifiedMs: 1,
      path: "folder/nested.txt",
    });

    render(
      <ControlledFileExplorer
        defaultViewMode="list"
        files={[nestedFile]}
        isLoading={false}
        onDownload={vi.fn().mockResolvedValue(undefined)}
        onRename={onRename}
      />
    );

    const folderTitle = screen.getByText("folder");
    const folderRow = folderTitle.closest("div.cursor-pointer");
    expect(folderRow).toBeInstanceOf(HTMLElement);
    if (!(folderRow instanceof HTMLElement)) {
      throw new Error("Folder row not found.");
    }

    await user.click(within(folderRow).getByRole("button"));
    await user.click(screen.getByText("Rename"));

    expect(onRename).toHaveBeenCalledWith({
      kind: "folder",
      name: "folder",
      path: "conversation-c1/folder",
    });
  });

  it("downloads a folder from its canonical path", async () => {
    const user = userEvent.setup();
    const onDownload = vi.fn().mockResolvedValue(undefined);
    const nestedFile = makeFile({
      contentType: "text/plain",
      fileName: "nested.txt",
      lastModifiedMs: 1,
      path: "folder/nested.txt",
    });

    render(
      <ControlledFileExplorer
        defaultViewMode="list"
        files={[nestedFile]}
        isLoading={false}
        onDownload={onDownload}
      />
    );

    const folderTitle = screen.getByText("folder");
    const folderRow = folderTitle.closest("div.cursor-pointer");
    expect(folderRow).toBeInstanceOf(HTMLElement);
    if (!(folderRow instanceof HTMLElement)) {
      throw new Error("Folder row not found.");
    }

    await user.click(within(folderRow).getByRole("button"));
    await user.click(screen.getByText("Download"));

    expect(onDownload).toHaveBeenCalledWith({
      kind: "folder",
      name: "folder",
      path: "conversation-c1/folder",
    });
  });
});

describe("FileExplorer Frame packages", () => {
  it("renames a Frame package from its source folder name", async () => {
    const user = userEvent.setup();
    const manifest = makeFile({
      contentType: "application/json",
      fileName: "manifest.json",
      fileResourceContentType: frameV2ContentType,
      lastModifiedMs: 2,
      path: "status/manifest.json",
    });
    const onRename = vi.fn();

    render(
      <ControlledFileExplorer
        defaultViewMode="list"
        displayFramePackages
        files={[manifest]}
        isLoading={false}
        onDownload={vi.fn().mockResolvedValue(undefined)}
        onRename={onRename}
      />
    );

    const packageTitle = screen.getByText("status");
    const packageRow = packageTitle.closest("div.cursor-pointer");
    if (!(packageRow instanceof HTMLElement)) {
      throw new Error("Frame package row not found.");
    }

    await user.click(within(packageRow).getByRole("button"));
    await user.click(screen.getByText("Rename"));

    expect(onRename).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: "file-manifest.json",
        kind: "frame_package",
        fileName: "status",
      })
    );
  });

  it("offers no Rename on a Frame package when renaming is unavailable", async () => {
    const user = userEvent.setup();
    const manifest = makeFile({
      contentType: "application/json",
      fileName: "manifest.json",
      fileResourceContentType: frameV2ContentType,
      lastModifiedMs: 2,
      path: "status/manifest.json",
    });

    render(
      <ControlledFileExplorer
        defaultViewMode="list"
        displayFramePackages
        files={[manifest]}
        isLoading={false}
        onDownload={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const packageRow = screen
      .getByText("status")
      .closest("div.cursor-pointer") as HTMLElement;
    await user.click(within(packageRow).getByRole("button"));

    expect(screen.queryByText("Rename")).not.toBeInTheDocument();
  });

  it("opens the Frame and downloads its source folder", async () => {
    const user = userEvent.setup();
    const manifest = makeFile({
      contentType: "application/json",
      fileName: "manifest.json",
      fileResourceContentType: frameV2ContentType,
      lastModifiedMs: 2,
      path: "status/manifest.json",
    });
    const source = makeFile({
      contentType: "text/typescript",
      fileName: "index.tsx",
      lastModifiedMs: 1,
      path: "status/index.tsx",
    });
    const onOpenInteractive = vi.fn();
    const onOpenInPanel = vi.fn();
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const onDownload = vi.fn().mockResolvedValue(undefined);

    render(
      <ControlledFileExplorer
        defaultViewMode="list"
        displayFramePackages
        files={[manifest, source]}
        isLoading={false}
        onDelete={onDelete}
        onDownload={onDownload}
        onMoveFile={vi.fn().mockResolvedValue(new Ok(undefined))}
        onOpenInteractive={onOpenInteractive}
        onOpenInPanel={onOpenInPanel}
        onRename={vi.fn()}
      />
    );

    const packageTitle = screen.getByText("status");
    fireEvent.click(packageTitle);
    expect(onOpenInteractive).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: "file-manifest.json",
        kind: "frame_package",
        path: "conversation-c1/status/manifest.json",
        sourceFolderPath: "status",
      })
    );

    const packageRow = packageTitle.closest("div.cursor-pointer");
    expect(packageRow).toBeInstanceOf(HTMLElement);
    if (!(packageRow instanceof HTMLElement)) {
      throw new Error("Frame package row not found.");
    }
    await user.click(within(packageRow).getByRole("button"));
    await user.click(screen.getByText("Download"));
    expect(onDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "frame_package",
        path: "conversation-c1/status/manifest.json",
        sourceFolderCanonicalPath: "conversation-c1/status",
      })
    );

    await user.click(within(packageRow).getByRole("button"));
    expect(screen.getByText("View source")).toBeInTheDocument();
    // A Frame is renamed by moving its source folder, so Rename is offered but "Move to…",
    // which only handles single files, is not.
    expect(screen.getByText("Rename")).toBeInTheDocument();
    expect(screen.queryByText("Move to…")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Delete"));
    expect(onDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "frame_package",
        path: "conversation-c1/status/manifest.json",
      })
    );

    await user.click(within(packageRow).getByRole("button"));
    fireEvent.click(screen.getByText("View source"));
    const manifestTitle = await screen.findByText("manifest.json");
    expect(screen.getByText("index.tsx")).toBeInTheDocument();

    fireEvent.click(manifestTitle);
    expect(onOpenInPanel).toHaveBeenCalledWith(
      expect.objectContaining({ path: "conversation-c1/status/manifest.json" })
    );
  });
});

describe("FileExplorer preferences", () => {
  const file = makeFile({
    contentType: "text/plain",
    fileName: "notes.txt",
    lastModifiedMs: 1,
  });

  function renderExplorer() {
    return render(
      <ControlledFileExplorer
        defaultViewMode="grid"
        files={[file]}
        isLoading={false}
        onDownload={vi.fn().mockResolvedValue(undefined)}
      />
    );
  }

  function isListLayout() {
    const layout = screen
      .getByText("notes.txt")
      .closest("[data-layout]")
      ?.getAttribute("data-layout");
    return layout === "list";
  }

  async function pickListLayout(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Layout" }));
    await user.click(await screen.findByText("List"));
  }

  it("restores view and sort mode after a remount", async () => {
    const user = userEvent.setup();
    const { unmount } = renderExplorer();
    expect(isListLayout()).toBe(false);

    await pickListLayout(user);
    await user.click(screen.getByRole("button", { name: "Last modified" }));
    await user.click(await screen.findByText("Name Z → A"));
    expect(isListLayout()).toBe(true);
    unmount();

    renderExplorer();
    expect(isListLayout()).toBe(true);
    expect(
      screen.getByRole("button", { name: "Name Z → A" })
    ).toBeInTheDocument();
  });
});

describe("FileExplorer content node opening", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeNode(fileName: string, sourceUrl: string): ContentNodeEntry {
    return {
      kind: "node",
      fileName,
      path: `node:${fileName}`,
      lastModifiedMs: null,
      sourceUrl,
      nodeId: `node-${fileName}`,
      nodeDataSourceViewId: "dsv-1",
      connectorProvider: null,
    };
  }

  it("only opens http(s) sourceUrl values, without opener access", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const readme = makeFile({
      contentType: "text/plain",
      fileName: "readme.txt",
      lastModifiedMs: 1,
    });

    render(
      <ControlledFileExplorer
        defaultViewMode="list"
        files={[readme]}
        contentNodes={[
          makeNode("Safe doc", "https://example.com/doc"),
          makeNode("Unsafe doc", "javascript:alert(1)"),
        ]}
        isLoading={false}
        onDownload={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.click(screen.getByText("Unsafe doc"));
    expect(open).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Safe doc"));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      "https://example.com/doc",
      "_blank",
      "noopener,noreferrer"
    );
  });
});
