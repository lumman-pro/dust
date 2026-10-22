import { useSendApiErrorNotification } from "@app/hooks/useNotification";
import { clientFetch } from "@app/lib/egress/client";
import { getErrorFromResponse } from "@app/lib/swr/swr";
import type { LightWorkspaceType } from "@app/types/user";
import { useLingui } from "@lingui/react/macro";

export function useEnterFrameDraftMode({
  owner,
  frameId,
}: {
  owner: LightWorkspaceType;
  frameId: string;
}) {
  const { t } = useLingui();
  const sendApiErrorNotification = useSendApiErrorNotification();

  return async (): Promise<boolean> => {
    const res = await clientFetch(
      `/api/w/${owner.sId}/frames/${encodeURIComponent(frameId)}/draft-mode`,
      { method: "POST" }
    );

    if (!res.ok) {
      sendApiErrorNotification({
        title: t`Could not turn on draft mode`,
        error: await getErrorFromResponse(res),
      });
      return false;
    }
    return true;
  };
}
