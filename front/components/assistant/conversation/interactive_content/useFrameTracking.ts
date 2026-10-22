import { useConversationSidePanelContext } from "@app/components/assistant/conversation/ConversationSidePanelContext";
import type {
  FrameExpandUiElement,
  FrameOpenLocation,
  FrameOpenOrigin,
} from "@app/components/assistant/conversation/interactive_content/frameTracking";
import {
  trackFrameExpand,
  trackFrameOpen,
} from "@app/components/assistant/conversation/interactive_content/frameTracking";
import type { TrackingExtra } from "@app/lib/tracking";
import { useEffect, useRef } from "react";

interface UseFrameTrackingParams {
  // Null until the Frame's data is loaded.
  frameId: string | null;
  // Null when there is nowhere to attribute the open to (e.g. a panel without a conversation).
  location: FrameOpenLocation | null;
  // Null when the Frame is shown again without being opened (back through the panel history).
  openedFrom: FrameOpenOrigin | null;
  isVisible: boolean;
  // For views with a full screen mode. `countOnShow`: the view only starts in full screen when the user
  // asked for it, so that counts as an expand (unlike a full screen restored from the URL).
  fullScreen?: {
    isFullScreen: boolean;
    uiElement: FrameExpandUiElement;
    countOnShow?: boolean;
  };
  extra?: TrackingExtra;
}

/**
 * @cc [owner:theogz,label:product] frame-views-track-with-one-hook
 * Views showing a Frame MUST track it through `useFrameTracking`, which MUST send
 * `frames:frame:open` once each time the Frame becomes shown (visible, data loaded, location known)
 * and not while it refreshes, and `frames:frame:expand` only when a shown Frame enters full screen,
 * not when it leaves it, nor when it is shown already in full screen unless the view says the user
 * asked for it (`countOnShow`).
 */
export function useFrameTracking({
  frameId,
  location,
  openedFrom,
  isVisible,
  fullScreen,
  extra,
}: UseFrameTrackingParams) {
  const shownFrameId = isVisible && location ? frameId : null;

  // Frame counted as opened since it was last hidden.
  const openedFrameIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!shownFrameId || !location) {
      openedFrameIdRef.current = null;
      return;
    }
    if (openedFrameIdRef.current === shownFrameId) {
      return;
    }
    openedFrameIdRef.current = shownFrameId;
    if (openedFrom) {
      trackFrameOpen({
        frameId: shownFrameId,
        origin: openedFrom,
        location,
        extra,
      });
    }
  }, [shownFrameId, location, openedFrom, extra]);

  // Starts from the mount value, so a Frame loaded in full screen is not counted as an expand.
  const isFullScreen = !!fullScreen?.isFullScreen;
  const wasFullScreenRef = useRef(isFullScreen && !fullScreen?.countOnShow);
  useEffect(() => {
    const wasFullScreen = wasFullScreenRef.current;
    wasFullScreenRef.current = isFullScreen;
    if (!isFullScreen || wasFullScreen || !shownFrameId || !location) {
      return;
    }
    if (fullScreen) {
      trackFrameExpand({
        frameId: shownFrameId,
        uiElement: fullScreen.uiElement,
        location,
      });
    }
  }, [isFullScreen, shownFrameId, location, fullScreen]);
}

// For Frames in the side panel (conversations and Pods): visible unless the panel is closing, opened
// by what the panel says opened it. Where the panel cannot be resized, the full screen hash is set but
// nothing changes on screen, so it is not a full screen.
export function useSidePanelFrameTracking({
  frameId,
  location,
  uiElement,
  isFullScreen,
  canEnterFullScreen,
}: {
  frameId: string;
  location: FrameOpenLocation;
  uiElement: FrameExpandUiElement;
  isFullScreen: boolean;
  canEnterFullScreen: boolean;
}) {
  const { isPanelClosing, frameOpenedFrom } = useConversationSidePanelContext();
  useFrameTracking({
    frameId,
    location,
    openedFrom: frameOpenedFrom,
    isVisible: !isPanelClosing,
    fullScreen: { isFullScreen: isFullScreen && canEnterFullScreen, uiElement },
  });
}
