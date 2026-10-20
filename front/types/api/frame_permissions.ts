import type { FrameToolCallPair } from "@app/types/api/frame_publication";

export type GetFramePermissionsResponseBody = {
  canWriteFrameSource: boolean;
  /**
   * Temporary alias of `canWriteFrameSource` for clients that still decode the old field
   * (mobile `FramePermissions`, open web tabs). Remove once those clients ship the rename.
   */
  isFrameAuthor: boolean;
  /** Scoped path of the Frame package root (`conversation-…/MyFrame`), when known. */
  packageRoot: string | null;
  /** Display name of the Frame (folder name), when known. */
  frameName: string | null;
  /**
   * Whether the publication this request is served declares at least one function: the latest
   * one for a writer asking with `publication=latest` (the conversation panel), live otherwise.
   */
  hasFunctions: boolean;
  /** Publication the share link, and anyone who cannot edit, is served. */
  livePublicationId: string | null;
  /** When the live publication was published, in ms since epoch. */
  livePublishedAt: number | null;
  /**
   * Latest publication when it differs from the live one (a draft is pending), reported only to
   * callers who can edit the Frame.
   */
  draftPublicationId: string | null;
  /**
   * Whether the Frame is in draft mode (every publish is a draft until one is made live), reported
   * only to callers who can edit the Frame.
   */
  draftMode: boolean;
  /** Live publication's frame-level tools.call pairs; empty when none or no publication. */
  requiredTools: FrameToolCallPair[];
  /**
   * Tools the current user already authorized for this Frame.
   * Used by the consent UI to mark newly required tools.
   */
  authorizedTools: FrameToolCallPair[];
  /** True when the current user published the live publication. */
  isLastPublisher: boolean;
  /** Full name of the user who published the live publication, when known. */
  lastPublisherName: string | null;
  /**
   * True when the viewer may use the Frame's tools without further consent:
   * no required tools, last publisher, or stored authorization covers requiredTools.
   */
  hasAuthorizedRequiredTools: boolean;
};

export type PostFrameToolAuthorizationResponseBody = {
  authorizedTools: FrameToolCallPair[];
};
