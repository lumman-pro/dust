import { cn, Tooltip } from "@dust-tt/sparkle";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

/** Marks the panel content as the Frame's draft while draft mode is on. */
export function FrameDraftModeBorder({
  isDraftMode,
  children,
}: {
  isDraftMode: boolean;
  children: ReactNode;
}) {
  const { t } = useLingui();

  return (
    <div
      className={cn(
        "relative h-full",
        isDraftMode && "border-2 border-golden-500"
      )}
    >
      {children}
      {isDraftMode && (
        <Tooltip
          label={t`Changes stay in this draft until you validate it. The share link shows the live version.`}
          side="left"
          tooltipTriggerAsChild
          trigger={
            <span className="absolute right-0 top-0 z-10 rounded-bl-md bg-golden-500 px-2 py-0.5 text-xs font-medium text-golden-950">
              {t`Draft`}
            </span>
          }
        />
      )}
    </div>
  );
}
