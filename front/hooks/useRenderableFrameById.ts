import type { RenderableFrame } from "@app/hooks/useRenderableFrameAtPath";
import { toRenderableFrame } from "@app/hooks/useRenderableFrameAtPath";
import { useFileContent, useFileMetadata } from "@app/lib/swr/files";
import { useFramePermissions } from "@app/lib/swr/frames";
import { getFrameFunctionReferenceKind } from "@app/types/api/frame_function_reference";
import { isFrameContentType, stripMimeParameters } from "@app/types/files";
import type { LightWorkspaceType } from "@app/types/user";

/**
 * @cc [owner:tdraier,label:product;security] renderable-frame-by-id
 * `frame` MUST be null unless the file `fileId` names loaded through the file API and its content
 * type, MIME parameters aside, is a Frame's; `frameId` MUST be the file id for a v2 Frame only.
 * The Frame MUST be scoped to its file's conversation when it has one, and to its pod otherwise,
 * and a v2 Frame MUST NOT be returned before its package root has loaded.
 */
export function useRenderableFrameById({
  owner,
  fileId,
}: {
  owner: LightWorkspaceType;
  fileId: string;
}): {
  frame: RenderableFrame | null;
  conversationId: string | null;
  podId: string | null;
  framePackageRoot: string | null;
  isLoading: boolean;
} {
  const { fileMetadata, isFileMetadataLoading, isFileMetadataError } =
    useFileMetadata({ fileId, owner });
  const contentType =
    fileMetadata && !isFileMetadataError
      ? stripMimeParameters(fileMetadata.contentType)
      : null;
  const isFrame = contentType !== null && isFrameContentType(contentType);
  const isV2 = isFrame && getFrameFunctionReferenceKind(contentType) === "v2";

  const { fileContent, isFileContentLoading, error } = useFileContent({
    fileId,
    owner,
    config: { disabled: !isFrame },
  });
  const { packageRoot, isFramePermissionsLoading } = useFramePermissions({
    owner,
    frameId: fileId,
    disabled: !isV2,
  });

  const conversationId = fileMetadata?.useCaseMetadata?.conversationId ?? null;

  return {
    frame:
      isFrame && !error && fileMetadata
        ? toRenderableFrame({
            fileId,
            fileContent,
            fileContentType: fileMetadata.contentType,
          })
        : null,
    conversationId,
    podId: conversationId
      ? null
      : (fileMetadata?.useCaseMetadata?.spaceId ?? null),
    framePackageRoot: isV2 ? packageRoot : null,
    isLoading:
      isFileMetadataLoading ||
      (isFrame && isFileContentLoading) ||
      (isV2 && isFramePermissionsLoading),
  };
}
