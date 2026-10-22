import type {
  AuditAction,
  AuditTargetType,
} from "@app/lib/api/audit/workos_audit";
import type { ShareableFileKind } from "@app/types/files";

export type ShareAuditEvent =
  | "shareScopeUpdated"
  | "emailGrantAdded"
  | "domainGrantAdded"
  | "emailGrantRevoked"
  | "domainGrantRevoked";

interface ShareAuditConfig {
  targetType: AuditTargetType;
  nameMetadataKey: string;
  actions: Record<ShareAuditEvent, AuditAction>;
}

// Audit names are part of the WorkOS audit log schema: an existing kind's entries must not change.
export const SHARE_AUDIT_BY_KIND: Record<ShareableFileKind, ShareAuditConfig> =
  {
    frame: {
      targetType: "frame",
      nameMetadataKey: "frame_name",
      actions: {
        shareScopeUpdated: "frame.share_scope_updated",
        emailGrantAdded: "frame.email_grant_added",
        domainGrantAdded: "frame.domain_grant_added",
        emailGrantRevoked: "frame.email_grant_revoked",
        domainGrantRevoked: "frame.domain_grant_revoked",
      },
    },
  };
