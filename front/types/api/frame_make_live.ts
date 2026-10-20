import { z } from "zod";

export const MakeFrameDraftLiveRequestBodySchema = z.object({
  /**
   * The latest publication the caller is showing: the pending draft, or the live publication when
   * nothing changed in draft mode (making it live then only ends draft mode).
   */
  draftPublicationId: z.string().min(1),
});

export type PostMakeFrameDraftLiveResponseBody = { publicationId: string };
