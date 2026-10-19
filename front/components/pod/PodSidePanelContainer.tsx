import { useConversationSidePanelContext } from "@app/components/assistant/conversation/ConversationSidePanelContext";
import { SidePanelContainer } from "@app/components/assistant/conversation/SidePanelContainer";
import { PodFilePreviewPanel } from "@app/components/pod/files/PodFilePreviewPanel";
import { PodFramePanel } from "@app/components/pod/files/PodFramePanel";
import type { ConversationSidePanelType } from "@app/types/conversation_side_panel";
import {
  FILE_PREVIEW_SIDE_PANEL_TYPE,
  INTERACTIVE_CONTENT_SIDE_PANEL_TYPE,
} from "@app/types/conversation_side_panel";
import type { PodType } from "@app/types/space";
import type { LightWorkspaceType } from "@app/types/user";
import type { ReactNode } from "react";

const POD_SIDE_PANEL_TYPES: ConversationSidePanelType[] = [
  FILE_PREVIEW_SIDE_PANEL_TYPE,
  INTERACTIVE_CONTENT_SIDE_PANEL_TYPE,
];

interface PodSidePanelContainerProps {
  children: ReactNode;
  owner: LightWorkspaceType;
  pod: PodType | null;
}

export function PodSidePanelContainer({
  children,
  owner,
  pod,
}: PodSidePanelContainerProps) {
  const { currentPanel } = useConversationSidePanelContext();

  return (
    <SidePanelContainer
      isPanelOpen={!!pod && POD_SIDE_PANEL_TYPES.includes(currentPanel)}
      panel={
        pod && (
          <div className="dd-privacy-mask contents">
            <PodSidePanelContent owner={owner} pod={pod} />
          </div>
        )
      }
    >
      {children}
    </SidePanelContainer>
  );
}

interface PodSidePanelContentProps {
  owner: LightWorkspaceType;
  pod: PodType;
}

function PodSidePanelContent({ owner, pod }: PodSidePanelContentProps) {
  const { currentPanel, data } = useConversationSidePanelContext();

  switch (currentPanel) {
    case FILE_PREVIEW_SIDE_PANEL_TYPE:
      return <PodFilePreviewPanel owner={owner} podId={pod.sId} />;

    case INTERACTIVE_CONTENT_SIDE_PANEL_TYPE: {
      const fileId = data?.split("@")[0];
      return (
        fileId && (
          <PodFramePanel key={fileId} fileId={fileId} owner={owner} pod={pod} />
        )
      );
    }

    default:
      return null;
  }
}
