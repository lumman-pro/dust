import {
  useSendApiErrorNotification,
  useSendNotification,
} from "@app/hooks/useNotification";
import { clientFetch } from "@app/lib/egress/client";
import { getErrorFromResponse } from "@app/lib/swr/swr";
import type { LightWorkspaceType } from "@app/types/user";
import { useLingui } from "@lingui/react/macro";

export function useMakeFrameDraftLive({
  owner,
  frameId,
}: {
  owner: LightWorkspaceType;
  frameId: string;
}) {
  const { t } = useLingui();
  const sendApiErrorNotification = useSendApiErrorNotification();
  const sendNotification = useSendNotification();

  return async (draftPublicationId: string): Promise<boolean> => {
    const res = await clientFetch(
      `/api/w/${owner.sId}/frames/${encodeURIComponent(frameId)}/make-live`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftPublicationId }),
      }
    );

    if (!res.ok) {
      sendApiErrorNotification({
        title: t`Could not make the changes live`,
        error: await getErrorFromResponse(res),
      });
      return false;
    }

    sendNotification({
      type: "success",
      title: t`Changes are live`,
      description: t`The share link now shows this version.`,
    });
    return true;
  };
}
