export interface GetShareMetadataResponseBody {
  description: string | null;
  faviconUrl: string | null;
  logoUrl: string | null;
  ogImageUrl: string | null;
  requiresEmailVerification: boolean;
  shareUrl: string;
  showSignUpCta: boolean;
  title: string;
  workspaceId: string;
  workspaceName: string;
}

export type GetShareFrameMetadataResponseBody = GetShareMetadataResponseBody & {
  vizUrl: string;
};
