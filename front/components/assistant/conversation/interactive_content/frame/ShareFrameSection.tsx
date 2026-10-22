import { Button, Icon, InfoCircle, LoadingBlock } from "@dust-tt/sparkle";
import type { ComponentProps, ReactElement, ReactNode } from "react";

interface SectionProps {
  label: ReactElement | string;
  description?: string;
  children: ReactNode;
}

export function Section({ label, description, children }: SectionProps) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-0.5">
        <h3 className="label-sm text-foreground">{label}</h3>
        {description && (
          <Button
            variant="ghost-secondary"
            size="xs"
            icon={InfoCircle}
            tooltip={description}
          />
        )}
      </div>
      {children}
    </section>
  );
}

const EMPTY_STATE_CLASSNAME =
  "flex items-center gap-2 rounded-xl border border-dashed border-border-dark p-3 dark:border-border-form";

interface SectionEmptyStateProps {
  icon: ComponentProps<typeof Icon>["visual"];
  label: string;
}

export function SectionEmptyState({ icon, label }: SectionEmptyStateProps) {
  return (
    <div className={EMPTY_STATE_CLASSNAME}>
      <Icon visual={icon} size="xs" className="shrink-0 text-faint" />
      <span className="copy-xs text-muted-foreground">{label}</span>
    </div>
  );
}

// Same box as `SectionEmptyState`, so the common empty result replaces it without layout shift.
export function SectionEmptyStateSkeleton() {
  return (
    <div aria-hidden="true" className={EMPTY_STATE_CLASSNAME}>
      <LoadingBlock className="h-4 w-4 shrink-0" />
      <LoadingBlock className="h-3 w-24" />
    </div>
  );
}
