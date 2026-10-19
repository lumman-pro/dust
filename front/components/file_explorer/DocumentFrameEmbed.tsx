import { DocumentFrameFallback } from "@app/components/editor/document/DocumentFrame";
import { PodFrameVisualization } from "@app/components/pod/PodFrameVisualization";
import type { RenderableFrame } from "@app/hooks/useRenderableFrameAtPath";
import { useRenderableFrameAtPath } from "@app/hooks/useRenderableFrameAtPath";
import { useRenderableFrameById } from "@app/hooks/useRenderableFrameById";
import { AuthContext } from "@app/lib/auth/AuthContext";
import type {
  FrameEmbedProps,
  FrameEmbedSource,
} from "@app/lib/markdown/frame_embed";
import { useSpaceInfo } from "@app/lib/swr/spaces";
import { parseCanonicalScopedPath } from "@app/types/mount_path";
import type { LightWorkspaceType } from "@app/types/user";
import { Spinner } from "@dust-tt/sparkle";
import { useContext, useId } from "react";

interface DocumentFrameEmbedProps {
  owner: LightWorkspaceType;
  source: FrameEmbedSource;
  height: number;
  frameProps: FrameEmbedProps;
}

interface LoadedDocumentFrameProps extends DocumentFrameEmbedProps {
  frame: RenderableFrame | null;
  conversationId: string | null;
  podId: string | null;
  framePath: string | null;
  framePackageRoot?: string | null;
  isLoading: boolean;
}

function LoadedDocumentFrame({
  owner,
  source,
  height,
  frameProps,
  frame,
  conversationId,
  podId,
  framePath,
  framePackageRoot,
  isLoading,
}: LoadedDocumentFrameProps) {
  const vizUrl = useContext(AuthContext)?.vizUrl;
  const embedId = useId();
  const { spaceInfo: podInfo, isSpaceInfoLoading } = useSpaceInfo({
    workspaceId: owner.sId,
    spaceId: podId,
    disabled: podId === null,
  });

  if (isLoading || isSpaceInfoLoading) {
    return (
      <div className="flex h-24 items-center justify-center">
        <Spinner size="sm" />
      </div>
    );
  }

  if (!vizUrl || !frame) {
    return <DocumentFrameFallback source={source} />;
  }

  return (
    <div
      className="overflow-hidden rounded-xl ring-1 ring-border/60"
      style={{ height }}
    >
      <PodFrameVisualization
        owner={owner}
        spaceId={podId ?? undefined}
        conversationId={conversationId}
        fileContent={frame.fileContent}
        frameProps={frameProps}
        vizUrl={vizUrl}
        identifier={`viz-document-frame-${frame.fileId}-${embedId}`}
        isPodEditor={podInfo?.isEditor}
        isPodMember={podInfo?.isMember}
        frameId={frame.frameId}
        framePath={framePath}
        framePackageRoot={framePackageRoot}
      />
    </div>
  );
}

function DocumentFrameEmbedAtPath({
  path,
  ...props
}: DocumentFrameEmbedProps & { path: string }) {
  const scope = parseCanonicalScopedPath(path)?.scope;
  const { frame, isLoading } = useRenderableFrameAtPath({
    owner: props.owner,
    framePath: path,
  });

  return (
    <LoadedDocumentFrame
      {...props}
      frame={frame}
      conversationId={
        scope?.kind === "canonical-conversation" ? scope.id : null
      }
      podId={scope?.kind === "canonical-pod" ? scope.id : null}
      framePath={path}
      isLoading={isLoading}
    />
  );
}

function DocumentFrameEmbedById({
  fileId,
  ...props
}: DocumentFrameEmbedProps & { fileId: string }) {
  const { frame, conversationId, podId, framePackageRoot, isLoading } =
    useRenderableFrameById({ owner: props.owner, fileId });

  return (
    <LoadedDocumentFrame
      {...props}
      frame={frame}
      conversationId={conversationId}
      podId={podId}
      framePath={null}
      framePackageRoot={framePackageRoot}
      isLoading={isLoading}
    />
  );
}

/**
 * @cc [owner:tdraier,label:product;security] document-frame-embed-access
 * A Frame embedded in a document MUST load only through the file API, from its path or its file
 * id, so it shows only to a reader who can read the Frame's file; a source the API refuses or that
 * is not a Frame MUST show as its path or file id. It MUST render as a regular, non-editable
 * Frame, inline, at the height the document gives it, with the reader's editor and member status
 * in the Frame's pod for a Frame of a pod. It MUST receive the embed's props as its component's
 * props, under an identifier of its own, even when the document embeds the same Frame more than
 * once.
 */
export function DocumentFrameEmbed(props: DocumentFrameEmbedProps) {
  const { source } = props;
  return source.kind === "file_path" ? (
    <DocumentFrameEmbedAtPath {...props} path={source.path} />
  ) : (
    <DocumentFrameEmbedById {...props} fileId={source.fileId} />
  );
}
