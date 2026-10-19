import {
  DEFAULT_RIGHT_PANEL_SIZE,
  getDefaultRightPanelSize,
} from "@app/components/assistant/conversation/constant";
import { useConversationSidePanelContext } from "@app/components/assistant/conversation/ConversationSidePanelContext";
import { useHashParam } from "@app/hooks/useHashParams";
import { useLockDocumentScroll } from "@app/hooks/useLockDocumentScroll";
import { useIsMobile } from "@app/lib/swr/useIsMobile";
import { FULL_SCREEN_HASH_PARAM } from "@app/types/conversation_side_panel";
import { ResizableSidePanel } from "@dust-tt/sparkle";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import type { ImperativePanelHandle } from "react-resizable-panels";

interface SidePanelContainerProps {
  children: ReactNode;
  isPanelOpen: boolean;
  panel: ReactNode;
}

export function SidePanelContainer({
  children,
  isPanelOpen,
  panel,
}: SidePanelContainerProps) {
  const { currentPanel, setPanelRef, onPanelClosed } =
    useConversationSidePanelContext();
  const panelRef = useRef<ImperativePanelHandle | null>(null);
  const [fullScreenHash] = useHashParam(FULL_SCREEN_HASH_PARAM);
  const isFullScreen = fullScreenHash === "true";

  const isMobile = useIsMobile();
  const isMobilePanelOpen = isMobile && isPanelOpen;

  useLockDocumentScroll(isMobilePanelOpen);

  useEffect(() => {
    if (isMobile) {
      setPanelRef(null);
      return;
    }

    setPanelRef(panelRef.current);
  }, [isMobile, setPanelRef]);

  if (isMobile) {
    return (
      <div className="relative flex w-full flex-col">
        {children}
        {isPanelOpen && (
          <div className="fixed inset-0 z-50 flex flex-col overflow-hidden overscroll-none bg-panel-background">
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
              {panel}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <ResizableSidePanel
      ref={panelRef}
      isOpen={isPanelOpen}
      defaultSize={
        currentPanel
          ? getDefaultRightPanelSize(currentPanel)
          : DEFAULT_RIGHT_PANEL_SIZE
      }
      minContentSize={0}
      isResizable={!isFullScreen}
      onCollapse={onPanelClosed}
      panel={isPanelOpen && panel}
    >
      <div className="flex h-panel flex-col">{children}</div>
    </ResizableSidePanel>
  );
}
