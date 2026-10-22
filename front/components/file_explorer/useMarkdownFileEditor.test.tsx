import { useMarkdownFileEditor } from "@app/components/file_explorer/useMarkdownFileEditor";
import { writeFileContentByPath } from "@app/lib/swr/files";
import { LightWorkspaceFactory } from "@app/tests/utils/LightWorkspaceFactory";
import { Ok } from "@app/types/shared/result";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const flags = new Set<string>();
const COLLAB_URL = "ws://localhost/api/collab";
let collabUrl: string | undefined;

vi.mock("@app/lib/auth/AuthContext", () => ({
  useFeatureFlags: () => ({
    featureFlags: [...flags],
    hasFeature: (flag: string) => flags.has(flag),
  }),
  useCollabUrl: () => collabUrl,
}));

vi.mock("@app/hooks/useNotification", () => ({
  useSendApiErrorNotification: () => vi.fn(),
  useSendNotification: () => vi.fn(),
}));

vi.mock("@app/lib/swr/files", () => ({
  writeFileContentByPath: vi.fn(),
}));

const owner = LightWorkspaceFactory.build({ sId: "w_1", role: "user" });

const params = {
  category: "markdown" as const,
  entryPath: "conversation-abc/notes.md",
  fileUrl: "/files/notes.md",
  isActive: true,
  isContentLoading: false,
  isTooLarge: false,
  isTruncated: false,
  canWrite: true,
  owner,
  rawContent: "# Notes\n",
  processedContent: { text: "# Notes", format: "markdown" as const },
};

const revised = {
  ...params,
  rawContent: "# Notes, revised\n",
  processedContent: { text: "# Notes, revised", format: "markdown" as const },
};

describe("useMarkdownFileEditor", () => {
  beforeEach(() => {
    flags.clear();
    collabUrl = COLLAB_URL;
    vi.mocked(writeFileContentByPath).mockResolvedValue(new Ok(undefined));
  });

  it("opens the rich editor read-only, still live, when the mount refuses writes", () => {
    flags.add("co_edition");

    const { result } = renderHook(() =>
      useMarkdownFileEditor({ ...params, canWrite: false })
    );

    expect(result.current.canEdit).toBe(false);
    expect(result.current.richEditor?.readOnly).toBe(true);
    expect(result.current.richEditor?.path).toBe("conversation-abc/notes.md");
  });

  it("opens the rich editor read-only, not live and without comments, for a file without a path", () => {
    flags.add("co_edition");
    const commented =
      'Hi :comment-start{id=c1}there:comment-end{id=c1}\n\n:::annotations\n::comment{id=c1 status=open}\n\n::message{author=user:usr_daph name="Daph" at=2026-09-25T14:16:32.380Z}\n\nNote.\n:::\n';

    const { result } = renderHook(() =>
      useMarkdownFileEditor({
        ...params,
        entryPath: undefined,
        rawContent: commented,
      })
    );

    expect(result.current.canEdit).toBe(false);
    expect(result.current.richEditor?.readOnly).toBe(true);
    expect(result.current.richEditor?.path).toBeNull();
    expect(result.current.richEditor?.initialContent).toBe("Hi there\n");
  });

  it("opens no editor when the mount refuses writes and co_edition is off", () => {
    const { result } = renderHook(() =>
      useMarkdownFileEditor({ ...params, canWrite: false })
    );

    expect(result.current.canEdit).toBe(false);
    expect(result.current.richEditor).toBeNull();
  });

  it("keeps the plain editor when co_edition is off", () => {
    const { result } = renderHook(() => useMarkdownFileEditor(params));

    expect(result.current.richEditor).toBeNull();
    expect(result.current.canEdit).toBe(true);
  });

  it("keeps what was typed in the plain editor while its save was pending", async () => {
    let finishWrite: () => void = () => undefined;
    vi.mocked(writeFileContentByPath).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishWrite = () => resolve(new Ok(undefined));
        })
    );
    const { result } = renderHook(() => useMarkdownFileEditor(params));
    act(() => {
      result.current.setDraft("# Notes\n\nFirst");
    });

    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.save();
    });
    act(() => {
      result.current.setDraft("# Notes\n\nFirst, then more");
    });
    finishWrite();
    await act(async () => {
      await pending;
    });

    expect(result.current.content).toBe("# Notes\n\nFirst, then more");
    expect(result.current.isDirty).toBe(true);
  });

  it("keeps an undo back to the original text made while the save was pending", async () => {
    let finishWrite: () => void = () => undefined;
    vi.mocked(writeFileContentByPath).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishWrite = () => resolve(new Ok(undefined));
        })
    );
    const { result } = renderHook(() => useMarkdownFileEditor(params));
    act(() => {
      result.current.setDraft("# Notes\n\nFirst");
    });

    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.save();
    });
    act(() => {
      result.current.setDraft("# Notes");
    });
    finishWrite();
    await act(async () => {
      await pending;
    });

    expect(result.current.content).toBe("# Notes");
    expect(result.current.isDirty).toBe(true);
  });

  it("opens the rich editor for an editable Markdown file when co_edition is on", () => {
    flags.add("co_edition");

    const { result } = renderHook(() => useMarkdownFileEditor(params));

    expect(result.current.richEditor?.initialContent).toBe("# Notes\n");
    expect(result.current.richEditor?.readOnly).toBe(false);
  });

  it("keeps the plain editor when no live session server is reachable", () => {
    flags.add("co_edition");
    collabUrl = undefined;

    const { result } = renderHook(() => useMarkdownFileEditor(params));

    expect(result.current.richEditor).toBeNull();
    expect(result.current.canEdit).toBe(true);
  });

  it("opens no editor for writing when the preview text was cut", () => {
    flags.add("co_edition");

    const { result } = renderHook(() =>
      useMarkdownFileEditor({ ...params, isTruncated: true })
    );

    expect(result.current.richEditor).toBeNull();
    expect(result.current.canEdit).toBe(false);
  });

  it("does not open the plain editor on cut preview text when co_edition is off", () => {
    const { result } = renderHook(() =>
      useMarkdownFileEditor({ ...params, isTruncated: true })
    );

    expect(result.current.canEdit).toBe(false);
  });

  it("keeps a dirty plain draft when the file grows past the cut, and refuses to save it", async () => {
    const { result, rerender } = renderHook(
      (props) => useMarkdownFileEditor(props),
      { initialProps: params }
    );
    act(() => {
      result.current.setDraft("# Notes\n\nMine");
    });

    rerender({ ...revised, isTruncated: true });
    expect(result.current.canEdit).toBe(true);
    expect(result.current.content).toBe("# Notes\n\nMine");

    const writes = vi.mocked(writeFileContentByPath).mock.calls.length;
    await act(async () => {
      await result.current.save();
    });
    expect(vi.mocked(writeFileContentByPath).mock.calls.length).toBe(writes);
  });

  it("keeps a live editor open when the file is fetched again, even cut", () => {
    flags.add("co_edition");
    const { result, rerender } = renderHook(
      (props) => useMarkdownFileEditor(props),
      { initialProps: params }
    );
    const firstKey = result.current.richEditor?.mountKey;
    expect(result.current.richEditor?.collabUrl).toBe(COLLAB_URL);

    rerender(revised);
    expect(result.current.richEditor?.mountKey).toBe(firstKey);

    rerender({ ...revised, isTruncated: true });
    expect(result.current.richEditor?.mountKey).toBe(firstKey);
  });

  it("keeps an open live editor live when the collab URL goes away", () => {
    flags.add("co_edition");
    const { result, rerender } = renderHook(
      (props) => useMarkdownFileEditor(props),
      { initialProps: params }
    );
    const firstKey = result.current.richEditor?.mountKey;

    collabUrl = undefined;
    rerender(revised);
    expect(result.current.richEditor?.collabUrl).toBe(COLLAB_URL);
    expect(result.current.richEditor?.mountKey).toBe(firstKey);
  });

  it("does not let the file content decide which editor opens", () => {
    flags.add("co_edition");
    const unsupported = {
      ...params,
      processedContent: {
        text: "| a | b |\n|---|---|\n| 1 | 2 |",
        format: "markdown" as const,
      },
    };

    const { result } = renderHook(() => useMarkdownFileEditor(unsupported));

    expect(result.current.richEditor).not.toBeNull();
  });

  it("cycles the rich editor, the unprocessed source in edit mode and the read-only rich editor reopened on the file as fetched", () => {
    flags.add("show_debug_tools");
    flags.add("co_edition");
    const { result, rerender } = renderHook(
      (props) => useMarkdownFileEditor(props),
      { initialProps: params }
    );

    act(() => {
      result.current.cycleCollabViewMode();
    });
    expect(result.current.collabViewMode).toBe("source");
    expect(result.current.richEditor).toBeNull();
    expect(result.current.viewMode).toBe("edit");
    expect(result.current.content).toBe("# Notes\n");

    rerender(revised);
    act(() => {
      result.current.cycleCollabViewMode();
    });
    expect(result.current.collabViewMode).toBe("preview");
    expect(result.current.richEditor?.readOnly).toBe(true);
    expect(result.current.richEditor?.path).toBe(params.entryPath);
    expect(result.current.richEditor?.initialContent).toBe(
      "# Notes, revised\n"
    );

    act(() => {
      result.current.cycleCollabViewMode();
    });
    expect(result.current.collabViewMode).toBe("live");
    expect(result.current.richEditor?.readOnly).toBe(false);
  });

  it("does not leave the source while it holds an unsaved edit", () => {
    flags.add("show_debug_tools");
    flags.add("co_edition");
    const { result } = renderHook(() => useMarkdownFileEditor(params));
    act(() => {
      result.current.cycleCollabViewMode();
    });
    act(() => {
      result.current.setDraft("# Notes, mine");
    });

    act(() => {
      result.current.cycleCollabViewMode();
    });

    expect(result.current.collabViewMode).toBe("source");
    expect(result.current.content).toBe("# Notes, mine");
  });

  it("keeps the source in edit mode when asked for the preview", () => {
    flags.add("show_debug_tools");
    flags.add("co_edition");
    const { result } = renderHook(() => useMarkdownFileEditor(params));
    act(() => {
      result.current.cycleCollabViewMode();
    });

    act(() => {
      result.current.setViewMode("preview");
    });

    expect(result.current.viewMode).toBe("edit");
  });

  it("ignores the source switch when the plain editor cannot edit the cut text", () => {
    flags.add("show_debug_tools");
    flags.add("co_edition");
    const { result } = renderHook(() =>
      useMarkdownFileEditor({ ...params, isTruncated: true })
    );

    act(() => {
      result.current.cycleCollabViewMode();
    });

    expect(result.current.collabViewMode).toBe("live");
  });

  it("ignores the source switch when debug tools are not shown", () => {
    flags.add("co_edition");
    const { result } = renderHook(() => useMarkdownFileEditor(params));

    act(() => {
      result.current.cycleCollabViewMode();
    });

    expect(result.current.collabViewMode).toBe("live");
    expect(result.current.richEditor).not.toBeNull();
  });

  it("ignores the source switch when co_edition is off", () => {
    flags.add("show_debug_tools");
    const { result } = renderHook(() => useMarkdownFileEditor(params));

    act(() => {
      result.current.cycleCollabViewMode();
    });

    expect(result.current.collabViewMode).toBe("live");
    expect(result.current.viewMode).toBe("preview");
  });

  it("leaves the source when another file opens", () => {
    flags.add("show_debug_tools");
    flags.add("co_edition");
    const { result, rerender } = renderHook(
      (props) => useMarkdownFileEditor(props),
      { initialProps: params }
    );
    act(() => {
      result.current.cycleCollabViewMode();
    });

    rerender({ ...params, entryPath: "conversation-abc/other.md" });

    expect(result.current.collabViewMode).toBe("live");
    expect(result.current.richEditor).not.toBeNull();
  });
});
