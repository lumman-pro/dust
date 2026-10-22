import { Avatar, Button, ListItem, User01, XClose } from "@dust-tt/sparkle";
import { useLingui } from "@lingui/react/macro";
import type { ComponentProps, ReactNode } from "react";

interface FrameSharingRowProps {
  label: string;
  icon?: ComponentProps<typeof Avatar>["icon"];
  children: ReactNode;
  onRemove?: () => void;
  isRemoving?: boolean;
}

export function FrameSharingRow({
  label,
  icon = User01,
  children,
  onRemove,
  isRemoving = false,
}: FrameSharingRowProps) {
  const { t } = useLingui();

  return (
    <ListItem
      className="gap-2 px-3 py-2"
      itemsAlignment="center"
      hasSeparator={false}
    >
      <div aria-hidden="true" className="shrink-0">
        <Avatar
          size="sm"
          name={label}
          icon={icon}
          backgroundColor="bg-brand-support-blue"
          iconColor="text-brand-electric-blue"
          isRounded
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="whitespace-normal break-all text-sm font-medium text-foreground">
          {label}
        </span>
        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground empty:hidden">
          {children}
        </div>
      </div>
      {(onRemove || isRemoving) && (
        <Button
          variant="ghost"
          icon={XClose}
          tooltip={t`Remove ${label}`}
          size="xs"
          onClick={onRemove}
          isLoading={isRemoving}
        />
      )}
    </ListItem>
  );
}

interface FrameSharingListProps {
  label: string;
  children: ReactNode;
}

// Caps the list at about three and a half rows so the popover height stays bounded. The list is
// focusable so keyboard users can scroll rows that contain no focusable element.
export function FrameSharingList({ label, children }: FrameSharingListProps) {
  return (
    <ul
      aria-label={label}
      tabIndex={0}
      className="max-h-48 overflow-y-auto focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-highlight-300"
    >
      {children}
    </ul>
  );
}
