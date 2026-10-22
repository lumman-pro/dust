import type {
  FrameOpenLocation,
  FrameOpenOrigin,
} from "@app/components/assistant/conversation/interactive_content/frameTracking";
import {
  trackFrameExpand,
  trackFrameOpen,
} from "@app/components/assistant/conversation/interactive_content/frameTracking";
import { useFrameTracking } from "@app/components/assistant/conversation/interactive_content/useFrameTracking";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@app/components/assistant/conversation/interactive_content/frameTracking",
  () => ({ trackFrameExpand: vi.fn(), trackFrameOpen: vi.fn() })
);

const POD: FrameOpenLocation = { type: "pod", id: "vlt_1" };
const CLICK: FrameOpenOrigin = { source: "user", uiElement: "pod_files" };

interface Props {
  frameId: string | null;
  location: FrameOpenLocation | null;
  openedFrom: FrameOpenOrigin | null;
  isVisible: boolean;
  isFullScreen: boolean;
}

const DEFAULT_PROPS: Props = {
  frameId: "fil_1",
  location: POD,
  openedFrom: CLICK,
  isVisible: true,
  isFullScreen: false,
};

function renderFrameTracking(initialProps: Partial<Props> = {}) {
  return renderHook(
    ({ isFullScreen, ...props }: Props) =>
      useFrameTracking({
        ...props,
        fullScreen: { isFullScreen, uiElement: "pod_files" },
      }),
    { initialProps: { ...DEFAULT_PROPS, ...initialProps } }
  );
}

beforeEach(() => {
  vi.mocked(trackFrameOpen).mockClear();
  vi.mocked(trackFrameExpand).mockClear();
});

describe("useFrameTracking", () => {
  it("counts a shown Frame once while it re-renders", () => {
    const { rerender } = renderFrameTracking();
    rerender({ ...DEFAULT_PROPS });
    rerender({ ...DEFAULT_PROPS, openedFrom: { ...CLICK } });

    expect(trackFrameOpen).toHaveBeenCalledTimes(1);
    expect(trackFrameOpen).toHaveBeenCalledWith({
      frameId: "fil_1",
      origin: CLICK,
      location: POD,
      extra: undefined,
    });
  });

  it("counts again once hidden and shown, or when another Frame is shown", () => {
    const { rerender } = renderFrameTracking();
    rerender({ ...DEFAULT_PROPS, isVisible: false });
    rerender({ ...DEFAULT_PROPS });
    rerender({ ...DEFAULT_PROPS, frameId: "fil_2" });

    expect(trackFrameOpen).toHaveBeenCalledTimes(3);
  });

  it("waits for the Frame's data and location", () => {
    const { rerender } = renderFrameTracking({ frameId: null });
    rerender({ ...DEFAULT_PROPS, location: null });
    expect(trackFrameOpen).not.toHaveBeenCalled();

    rerender({ ...DEFAULT_PROPS });
    expect(trackFrameOpen).toHaveBeenCalledTimes(1);
  });

  it("does not count a Frame shown without being opened", () => {
    const { rerender } = renderFrameTracking({ openedFrom: null });
    rerender({ ...DEFAULT_PROPS });

    expect(trackFrameOpen).not.toHaveBeenCalled();
  });

  it("counts entering full screen, not leaving it", () => {
    const { rerender } = renderFrameTracking();
    rerender({ ...DEFAULT_PROPS, isFullScreen: true });
    rerender({ ...DEFAULT_PROPS, isFullScreen: false });

    expect(trackFrameExpand).toHaveBeenCalledTimes(1);
    expect(trackFrameExpand).toHaveBeenCalledWith({
      frameId: "fil_1",
      uiElement: "pod_files",
      location: POD,
    });
  });

  it("does not count a Frame shown already in full screen", () => {
    renderFrameTracking({ isFullScreen: true });

    expect(trackFrameOpen).toHaveBeenCalledTimes(1);
    expect(trackFrameExpand).not.toHaveBeenCalled();
  });

  it("counts a Frame shown in full screen when the view says the user asked for it", () => {
    renderHook(() =>
      useFrameTracking({
        ...DEFAULT_PROPS,
        fullScreen: {
          isFullScreen: true,
          uiElement: "pod_pinned_banner",
          countOnShow: true,
        },
      })
    );

    expect(trackFrameOpen).toHaveBeenCalledTimes(1);
    expect(trackFrameExpand).toHaveBeenCalledTimes(1);
  });

  it("counts both when a hidden Frame is shown straight in full screen", () => {
    const { rerender } = renderFrameTracking({ isVisible: false });
    rerender({ ...DEFAULT_PROPS, isFullScreen: true });

    expect(trackFrameOpen).toHaveBeenCalledTimes(1);
    expect(trackFrameExpand).toHaveBeenCalledTimes(1);
  });
});
