import {
  useSendApiErrorNotification,
  useSendNotification,
} from "@app/hooks/useNotification";
import { useSubmitFunction } from "@app/lib/client/utils";
import { clientFetch } from "@app/lib/egress/client";
import {
  getFilePathContentApiPath,
  useWriteFileContentByPath,
} from "@app/lib/swr/files";
import {
  emptyArray,
  getErrorFromResponse,
  useFetcher,
  useSWRWithDefaults,
} from "@app/lib/swr/swr";
import type {
  GetDocumentSnapshotsResponseBody,
  PostDocumentSnapshotResponseBody,
} from "@app/types/api/file_system/types";
import type { LightWorkspaceType } from "@app/types/user";
import { useLingui } from "@lingui/react/macro";

/** A doc's snapshots and the actions on them: take one now, or restore one into the doc. */
export function useDocumentHistory({
  owner,
  canonicalPath,
  disabled,
}: {
  owner: LightWorkspaceType;
  canonicalPath: string;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const { fetcher } = useFetcher();
  const sendNotification = useSendNotification();
  const sendApiErrorNotification = useSendApiErrorNotification();
  const writeFileContent = useWriteFileContentByPath({ owner });
  const docUrl = getFilePathContentApiPath(owner, canonicalPath);

  // An array key, so revalidating the list never refreshes the doc's own content.
  const { data, error, mutate } = useSWRWithDefaults(
    [`${docUrl}?history=list`] as const,
    ([url]: readonly [string]): Promise<GetDocumentSnapshotsResponseBody> =>
      fetcher(url),
    { disabled }
  );

  const { submit: takeSnapshot, isSubmitting: isTakingSnapshot } =
    useSubmitFunction(async () => {
      const response = await clientFetch(`${docUrl}?action=snapshot`, {
        method: "POST",
      });
      if (!response.ok) {
        sendApiErrorNotification({
          title: t`Failed to take a snapshot`,
          error: await getErrorFromResponse(response),
        });
        return;
      }
      const { snapshot }: PostDocumentSnapshotResponseBody =
        await response.json();
      sendNotification({ type: "success", title: t`Snapshot taken` });
      await mutate(
        (current) => ({
          snapshots: [snapshot, ...(current?.snapshots ?? [])],
        }),
        { revalidate: false }
      );
    });

  const { submit: restoreSnapshot, isSubmitting: isRestoring } =
    useSubmitFunction(async (snapshotPath: string) => {
      const response = await clientFetch(
        getFilePathContentApiPath(owner, snapshotPath)
      );
      if (!response.ok) {
        sendApiErrorNotification({
          title: t`Failed to read the snapshot`,
          error: await getErrorFromResponse(response),
        });
        return;
      }
      const restored = await writeFileContent({
        canonicalPath,
        content: await response.text(),
        contentType: "text/markdown",
      });
      if (restored.isOk()) {
        sendNotification({ type: "success", title: t`Snapshot restored` });
      }
    });

  return {
    snapshots: data?.snapshots ?? emptyArray<string>(),
    isSnapshotsLoading: !error && !data && !disabled,
    takeSnapshot,
    isTakingSnapshot,
    restoreSnapshot,
    isRestoring,
  };
}
