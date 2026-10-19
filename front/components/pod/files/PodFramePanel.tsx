import { AuthenticatedVisualizationActionIframe } from "@app/components/assistant/conversation/actions/AuthenticatedVisualizationActionIframe";
import { DEFAULT_FRAME_PANEL_SIZE } from "@app/components/assistant/conversation/constant";
import { ConversationSidePanelHeader } from "@app/components/assistant/conversation/ConversationSidePanelHeader";
import { CenteredState } from "@app/components/assistant/conversation/interactive_content/CenteredState";
import { FrameCodeView } from "@app/components/assistant/conversation/interactive_content/frame/FrameCodeView";
import { FrameToolbar } from "@app/components/assistant/conversation/interactive_content/frame/FrameToolbar";
import { FrameToolConsentGate } from "@app/components/assistant/conversation/interactive_content/frame/FrameToolConsentGate";
import { PreviewActionButtons } from "@app/components/assistant/conversation/interactive_content/frame/PreviewActionButtons";
import { useFrameEditSession } from "@app/components/assistant/conversation/interactive_content/frame/useFrameEditSession";
import { useLiveFrameEditing } from "@app/components/assistant/conversation/interactive_content/frame/useLiveFrameEditing";
import { useSidePanelFullScreen } from "@app/components/assistant/conversation/useSidePanelFullScreen";
import { useAuth } from "@app/lib/auth/AuthContext";
import {
  useFileContent,
  useFileContentByUrl,
  useFileMetadata,
  useShareInteractiveContentFile,
} from "@app/lib/swr/files";
import { usePodFiles } from "@app/lib/swr/pods";
import { useIsMobile } from "@app/lib/swr/useIsMobile";
import { getFrameFunctionReferenceKind } from "@app/types/api/frame_function_reference";
import { getFrameV2NameFromManifestPath } from "@app/types/api/frame_manifest";
import type { PodType } from "@app/types/space";
import type { LightWorkspaceType } from "@app/types/user";
import { Spinner } from "@dust-tt/sparkle";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { useRef, useState } from "react";

interface PodFramePanelProps {
  fileId: string;
  owner: LightWorkspaceType;
  pod: PodType;
}

export function PodFramePanel({ fileId, owner, pod }: PodFramePanelProps) {
  const { t } = useLingui();
  const { vizUrl } = useAuth();
  const isMobile = useIsMobile();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [showCode, setShowCode] = useState(false);
  const { isFullScreen, enterFullScreen, exitFullScreen, closePanel } =
    useSidePanelFullScreen(DEFAULT_FRAME_PANEL_SIZE);

  const { fileContent, mutateFileContent } = useFileContent({
    fileId,
    owner,
  });

  const { files: podFiles, isPodFilesLoading } = usePodFiles({
    owner,
    podId: pod.sId,
  });
  const framePath =
    podFiles.find((file) => !file.isDirectory && file.fileId === fileId)
      ?.path ?? null;

  // A Frames v2 package is named by the folder holding its manifest. Legacy Frames have no
  // manifest and fall back to their file name.
  const frameName = framePath
    ? getFrameV2NameFromManifestPath(framePath)
    : null;

  const { fileMetadata, isFileMetadataLoading, isFileMetadataError } =
    useFileMetadata({ fileId, owner });
  const functionReferenceKind = getFrameFunctionReferenceKind(
    fileMetadata?.contentType
  );
  const isV2 = functionReferenceKind === "v2";

  const {
    canEditV2,
    canWriteFrameSource,
    hasFrameFunctions,
    requiredTools,
    hasAuthorizedRequiredTools,
    isFramePermissionsLoading,
    mutateFramePermissions,
    status: draftStatus,
  } = useLiveFrameEditing({
    owner,
    frameId: fileId,
    isV2,
    disabled: !isV2,
  });
  const needsToolConsent =
    isV2 && !isFramePermissionsLoading && !hasAuthorizedRequiredTools;

  const { fileShare } = useShareInteractiveContentFile({ fileId, owner });

  const frameSourceBaseUrl = `/api/w/${owner.sId}/frames/${encodeURIComponent(fileId)}/source`;
  const {
    fileContent: frameSource,
    isNotFound: isFrameSourceNotFound,
    isFileContentLoading: isFrameSourceLoading,
    fileContentError: frameSourceError,
  } = useFileContentByUrl({
    url: frameSourceBaseUrl,
    disabled: !isV2 || !showCode,
  });

  const editSession = useFrameEditSession({
    owner,
    fileId,
    conversationId: undefined,
    iframeRef,
    mutateFileContent,
    onSaved: mutateFramePermissions,
  });

  const framePackageRoot =
    framePath && framePath.includes("/")
      ? framePath.slice(0, framePath.lastIndexOf("/"))
      : null;

  const vizInstanceKey = `viz-${fileId}${
    isV2 ? `-${editSession.contentRevision}` : ""
  }`;

  const [isReloading, setIsReloading] = useState(false);
  const reloadFile = async () => {
    setIsReloading(true);
    await mutateFileContent();
    if (isV2) {
      editSession.remount();
    }
    setIsReloading(false);
  };

  let body: ReactNode;
  if (
    isFileMetadataLoading ||
    isReloading ||
    isPodFilesLoading ||
    (isV2 && isFramePermissionsLoading)
  ) {
    body = (
      <CenteredState>
        <Spinner />
      </CenteredState>
    );
  } else if (isFileMetadataError || !fileMetadata || !functionReferenceKind) {
    body = (
      <CenteredState>
        <p className="text-sm text-muted-foreground">
          <Trans>This frame is no longer available in the Pod files.</Trans>
        </p>
      </CenteredState>
    );
  } else if (!fileContent) {
    body = (
      <CenteredState>
        <Spinner />
      </CenteredState>
    );
  } else if (needsToolConsent) {
    body = (
      <FrameToolConsentGate
        owner={owner}
        frameId={fileId}
        requiredTools={requiredTools}
        onAuthorized={async () => {
          await mutateFramePermissions();
        }}
      />
    );
  } else {
    body = (
      <>
        {showCode ? (
          <FrameCodeView
            code={isV2 ? (frameSource ?? undefined) : fileContent}
            isLoading={isV2 && isFrameSourceLoading}
            hasError={
              isV2 && (isFrameSourceNotFound || Boolean(frameSourceError))
            }
          />
        ) : (
          vizUrl && (
            <div className="relative h-full">
              <AuthenticatedVisualizationActionIframe
                agentConfigurationId={
                  fileMetadata.useCaseMetadata
                    .lastEditedByAgentConfigurationId ?? null
                }
                workspaceId={owner.sId}
                vizUrl={vizUrl}
                visualization={{
                  code: fileContent,
                  complete: true,
                  identifier: `viz-${fileId}`,
                }}
                key={vizInstanceKey}
                conversationId={null}
                spaceId={fileMetadata.useCaseMetadata.spaceId}
                framePackageRoot={framePackageRoot}
                frameId={isV2 ? fileId : undefined}
                frameFileId={fileId}
                isInDrawer={true}
                isEditable={canEditV2}
                stagedEditMode={canEditV2 ? editSession.mode : undefined}
                onEditText={canEditV2 ? editSession.stageEdit : undefined}
                isPodEditor={pod.isEditor}
                isPodMember={pod.isMember}
                ref={iframeRef}
              />
              {editSession.isSaving && (
                <div
                  className="absolute inset-0 z-10 cursor-wait"
                  aria-busy="true"
                  aria-label={t`Publishing your changes...`}
                />
              )}
            </div>
          )
        )}
        <PreviewActionButtons
          isFullScreen={isFullScreen}
          enterFullScreen={enterFullScreen}
          exitFullScreen={exitFullScreen}
          shareUrl={fileShare?.shareUrl}
          reloadFile={() => void reloadFile()}
        />
      </>
    );
  }

  return (
    <div className="flex h-panel flex-col">
      <ConversationSidePanelHeader onClose={closePanel}>
        <FrameToolbar
          owner={owner}
          fileId={fileId}
          iframeRef={iframeRef}
          fileContent={fileContent ?? null}
          fileName={fileMetadata?.fileName}
          contentType={fileMetadata?.contentType}
          showCode={showCode}
          onToggleCode={
            !isV2 || canWriteFrameSource
              ? () => setShowCode(!showCode)
              : undefined
          }
          hasFrameFunctions={hasFrameFunctions}
          editSession={editSession}
          canEditV2={canEditV2}
          status={draftStatus}
          hideEditLabels={isMobile}
          podActions={{
            spaceId: pod.sId,
            pinnedFramePath: pod.pinnedFramePath ?? null,
            isEditor: pod.isEditor,
            framePath,
            fileName: frameName ?? fileMetadata?.fileName,
            fileTabs: pod.frameTabs ?? [],
            tabsOrder: pod.tabsOrder ?? [],
            hidden: !!pod.archivedAt,
          }}
        />
      </ConversationSidePanelHeader>
      <div className="flex-1 overflow-hidden">{body}</div>
    </div>
  );
}
