import { PageLayout } from "@app/components/layouts/PageLayout";
import { useAdminSectionHighlight } from "@app/hooks/useAdminSectionHighlight";
import type { ReactNode } from "react";

interface AdminPageContainerProps {
  children: ReactNode;
  className?: string;
}

export function AdminPageContainer({
  children,
  className,
}: AdminPageContainerProps) {
  useAdminSectionHighlight();

  return <PageLayout className={className}>{children}</PageLayout>;
}
