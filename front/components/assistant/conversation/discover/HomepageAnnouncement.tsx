import { AnnouncementPill } from "@dust-tt/sparkle";
import type { ComponentType, CSSProperties } from "react";

interface HomepageAnnouncementEntry {
  isVisible: boolean;
  icon: ComponentType<{ className?: string }>;
  label: string;
  /** Destination of the pill; it is static text without one. */
  href?: string;
  target?: string;
}

interface HomepageAnnouncementProps {
  style?: CSSProperties;
}

export function HomepageAnnouncement({ style }: HomepageAnnouncementProps) {
  // The first visible entry is shown; add new announcements at the top.
  const announcements: HomepageAnnouncementEntry[] = [];

  const entry = announcements.find(({ isVisible }) => isVisible);
  if (!entry) {
    return null;
  }

  return (
    <div style={style}>
      <AnnouncementPill
        icon={entry.icon}
        label={entry.label}
        href={entry.href}
        target={entry.target}
      />
    </div>
  );
}
