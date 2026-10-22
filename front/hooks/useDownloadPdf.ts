import {
  useSendApiErrorNotification,
  useSendNotification,
} from "@app/hooks/useNotification";
import { clientFetch } from "@app/lib/egress/client";
import { getErrorFromResponse } from "@app/lib/swr/swr";
import { useLingui } from "@lingui/react/macro";

/** Fetch a PDF from `url` and download it as `fileName`, notifying the user of the outcome. */
export function useDownloadPdf() {
  const { t } = useLingui();
  const sendApiErrorNotification = useSendApiErrorNotification();
  const sendNotification = useSendNotification();

  return async ({
    url,
    init,
    fileName,
  }: {
    url: string;
    init?: RequestInit;
    fileName: string;
  }): Promise<boolean> => {
    const res = await clientFetch(url, init);

    if (!res.ok) {
      const errorData = await getErrorFromResponse(res);
      sendApiErrorNotification({
        title: t`PDF export failed`,
        error: errorData,
      });
      return false;
    }

    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(blobUrl);

    sendNotification({
      type: "success",
      title: t`PDF exported`,
      description: t`Your PDF has been downloaded.`,
    });
    return true;
  };
}
