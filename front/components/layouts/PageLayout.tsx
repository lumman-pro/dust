import { cn } from "@dust-tt/sparkle";
import type { ReactNode } from "react";

interface PageContainerProps {
  children: ReactNode;
  className?: string;
}

// Layout for admin pages and manage agent/skill pages
export function PageLayout({ children, className }: PageContainerProps) {
  // `shrink-0`: the container is a flex item of the scrolling column; without it
  // `min-h-full` lets it shrink to the viewport and the bottom padding is lost.
  return (
    <div
      className={cn(
        "mx-auto flex min-h-full w-full max-w-6xl shrink-0 flex-col px-4 sm:px-10 sm:pt-4",
        className
      )}
    >
      {children}
    </div>
  );
}
