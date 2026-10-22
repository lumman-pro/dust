import { Icon } from "@dust-tt/sparkle";
import type { ComponentType } from "react";

interface CollabViewModeFileIconProps {
  visual: ComponentType;
  className?: string;
  onCycleViewMode: () => void;
}

/**
 * A file's icon that hides the switch between its live editor, its Markdown source and its read-only
 * preview: Option/Alt-click cycles them.
 */
export function CollabViewModeFileIcon({
  visual,
  className,
  onCycleViewMode,
}: CollabViewModeFileIconProps) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden
      className="flex shrink-0 cursor-default"
      onClick={(event) => {
        if (event.altKey) {
          onCycleViewMode();
        }
      }}
    >
      <Icon visual={visual} size="sm" className={className} />
    </button>
  );
}
