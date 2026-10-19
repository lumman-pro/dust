import {
  parseFilePreviewData,
  useConversationSidePanelContext,
} from "@app/components/assistant/conversation/ConversationSidePanelContext";
import {
  FilePreviewPanelView,
  findListedFile,
} from "@app/components/assistant/conversation/files_panel/FilePreviewPanel";
import { usePodFiles } from "@app/lib/swr/pods";
import { resolveCanonicalScopedPath } from "@app/types/mount_path";
import type { LightWorkspaceType } from "@app/types/user";

interface PodFilePreviewPanelProps {
  owner: LightWorkspaceType;
  podId: string;
}

export function PodFilePreviewPanel({
  owner,
  podId,
}: PodFilePreviewPanelProps) {
  const { data } = useConversationSidePanelContext();
  const target = parseFilePreviewData(data);
  const path =
    target?.kind === "path"
      ? resolveCanonicalScopedPath(target.filePath, {
          conversationId: null,
          spaceId: podId,
        })
      : null;

  const { files, isPodFilesLoading } = usePodFiles({
    owner,
    podId,
    disabled: !path,
  });

  return (
    <FilePreviewPanelView
      owner={owner}
      target={target}
      path={path}
      listedFile={findListedFile(files, path)}
      isListingLoading={isPodFilesLoading}
    />
  );
}
