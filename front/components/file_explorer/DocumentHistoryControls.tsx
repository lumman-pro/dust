import { useDocumentHistory } from "@app/hooks/useDocumentHistory";
import { getFileNameFromScopedPath } from "@app/lib/markdown/file_preview";
import type { LightWorkspaceType } from "@app/types/user";
import { Button } from "@dust-tt/sparkle";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";

interface DocumentHistoryControlsProps {
  owner: LightWorkspaceType;
  canonicalPath: string;
}

// TODO(co-edition): remove once the document history UI exists. Temporary controls to try it.
export function DocumentHistoryControls({
  owner,
  canonicalPath,
}: DocumentHistoryControlsProps) {
  const { t } = useLingui();
  const [isListOpen, setIsListOpen] = useState(false);
  const { snapshots, isSnapshotsLoading, takeSnapshot, restoreSnapshot } =
    useDocumentHistory({ owner, canonicalPath, disabled: !isListOpen });

  return (
    <div className="flex flex-col gap-2 px-2 py-1">
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="xs"
          label={t`Take snapshot`}
          onClick={takeSnapshot}
        />
        <Button
          variant="outline"
          size="xs"
          label={isListOpen ? t`Hide snapshots` : t`Show snapshots`}
          onClick={() => setIsListOpen(!isListOpen)}
        />
      </div>
      {isListOpen && (
        <ul className="flex flex-col gap-1 text-sm">
          {isSnapshotsLoading && (
            <li>
              <Trans>Loading…</Trans>
            </li>
          )}
          {!isSnapshotsLoading && snapshots.length === 0 && (
            <li>
              <Trans>No snapshots yet.</Trans>
            </li>
          )}
          {snapshots.map((snapshot) => (
            <li key={snapshot} className="flex items-center gap-2">
              <span>{getFileNameFromScopedPath(snapshot)}</span>
              <Button
                variant="outline"
                size="xs"
                label={t`Restore`}
                onClick={() => restoreSnapshot(snapshot)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
