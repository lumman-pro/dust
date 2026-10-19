import { BlockedActionsProvider } from "@app/components/assistant/conversation/BlockedActionsProvider";
import { ErrorDisplay } from "@app/components/assistant/conversation/ConversationError";
import { ConversationSidePanelProvider } from "@app/components/assistant/conversation/ConversationSidePanelContext";
import { FileDropProvider } from "@app/components/assistant/conversation/FileUploaderContext";
import { GenerationContextProvider } from "@app/components/assistant/conversation/GenerationContextProvider";
import { ErrorBoundary } from "@app/components/error_boundary/ErrorBoundary";
import { PodSidePanelContainer } from "@app/components/pod/PodSidePanelContainer";
import {
  useSetHasTitle,
  useSetPageTitle,
} from "@app/components/sparkle/AppLayoutContext";
import { useActivePodId } from "@app/hooks/useActivePodId";
import { useSpaceInfo } from "@app/lib/swr/spaces";
import type { LightWorkspaceType } from "@app/types/user";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

interface PodLayoutProps {
  children: ReactNode;
  owner: LightWorkspaceType;
}

export function PodLayout({ children, owner }: PodLayoutProps) {
  const activePodId = useActivePodId();

  const { spaceInfo } = useSpaceInfo({
    workspaceId: owner.sId,
    spaceId: activePodId,
  });

  const pageTitle = spaceInfo ? `Dust - ${spaceInfo.name}` : "Dust";

  useSetHasTitle(!!activePodId);
  useSetPageTitle(pageTitle);

  return (
    <BlockedActionsProvider owner={owner}>
      {/* Keyed so a panel opened in one Pod does not follow into the next. */}
      <ConversationSidePanelProvider key={activePodId}>
        <ErrorBoundary fallback={<UncaughtPodErrorFallback />}>
          <PodSidePanelContainer owner={owner} pod={spaceInfo ?? null}>
            <FileDropProvider>
              <GenerationContextProvider>{children}</GenerationContextProvider>
            </FileDropProvider>
          </PodSidePanelContainer>
        </ErrorBoundary>
      </ConversationSidePanelProvider>
    </BlockedActionsProvider>
  );
}

function UncaughtPodErrorFallback() {
  const { t } = useLingui();

  return (
    <ErrorDisplay
      title={t`Something unexpected happened`}
      message={[
        t`Try refreshing the page to continue.`,
        t`Still having trouble? Reach out at support@dust.tt`,
      ]}
    />
  );
}
