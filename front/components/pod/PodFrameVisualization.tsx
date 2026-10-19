import { AuthenticatedVisualizationActionIframe } from "@app/components/assistant/conversation/actions/AuthenticatedVisualizationActionIframe";
import type { LightWorkspaceType } from "@app/types/user";
import { useRef } from "react";

interface PodFrameVisualizationProps {
  owner: LightWorkspaceType;
  spaceId?: string;
  conversationId?: string | null;
  fileContent: string;
  frameProps?: Record<string, string>;
  vizUrl: string;
  identifier: string;
  isPodEditor?: boolean;
  isPodMember?: boolean;
  /** Stable FileResource identity for Frame v2; omitted for legacy Frames. */
  frameId?: string;
  /** The Frame's file, legacy or v2, whose saved allowlist admits out-of-scope reads. */
  frameFileId?: string | null;
  /** Canonical path of the Frame file or manifest. */
  framePath?: string | null;
  /** The Frame's package directory, for a Frame shown without its path. */
  framePackageRoot?: string | null;
}

/**
 * Shared viz iframe used by the Pod pinned banner and Pod frame tabs.
 * Expects already-fetched renderable content (published bundle when available).
 */
export function PodFrameVisualization({
  owner,
  spaceId,
  conversationId = null,
  fileContent,
  frameProps,
  vizUrl,
  identifier,
  isPodEditor,
  isPodMember,
  frameId,
  frameFileId,
  framePath,
  framePackageRoot,
}: PodFrameVisualizationProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  return (
    <AuthenticatedVisualizationActionIframe
      agentConfigurationId={null}
      workspaceId={owner.sId}
      vizUrl={vizUrl}
      visualization={{
        code: fileContent,
        complete: true,
        identifier,
      }}
      conversationId={conversationId}
      spaceId={spaceId}
      framePackageRoot={
        framePath && framePath.includes("/")
          ? framePath.slice(0, framePath.lastIndexOf("/"))
          : (framePackageRoot ?? null)
      }
      frameId={frameId}
      frameFileId={frameFileId}
      frameProps={frameProps}
      isInDrawer={true}
      isPodEditor={isPodEditor}
      isPodMember={isPodMember}
      ref={iframeRef}
    />
  );
}
