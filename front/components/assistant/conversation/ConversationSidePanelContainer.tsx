import ConversationSidePanelContent from "@app/components/assistant/conversation/ConversationSidePanelContent";
import {
  useConversationSidePanelContext,
  useRegisterSidePanelConversation,
} from "@app/components/assistant/conversation/ConversationSidePanelContext";
import { SidePanelContainer } from "@app/components/assistant/conversation/SidePanelContainer";
import type { ConversationWithoutContentType } from "@app/types/assistant/conversation";
import type { LightWorkspaceType } from "@app/types/user";
import type { ReactNode } from "react";

interface ConversationSidePanelContainerProps {
  children: ReactNode;
  conversation?: ConversationWithoutContentType;
  owner: LightWorkspaceType;
}

export default function ConversationSidePanelContainer({
  children,
  conversation,
  owner,
}: ConversationSidePanelContainerProps) {
  const { currentPanel } = useConversationSidePanelContext();
  useRegisterSidePanelConversation(!!conversation);

  return (
    <SidePanelContainer
      isPanelOpen={!!currentPanel && !!conversation}
      panel={
        currentPanel &&
        conversation && (
          <ConversationSidePanelContent
            conversation={conversation}
            owner={owner}
            currentPanel={currentPanel}
          />
        )
      }
    >
      {children}
    </SidePanelContainer>
  );
}
