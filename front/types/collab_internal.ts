import { z } from "zod";

import { AGENT_ACTIVITIES, collabAgentSchema } from "@app/types/collab";

/**
 * Agents change a live document through the collab server's internal routes: they read the
 * session's source, change it, then write it back conditional on the source they read. An
 * agent's find-and-replace is sent as is instead, and applied by the session to its current source.
 */

/** Where the collab server mounts the routes only reached from inside the cluster. */
export const COLLAB_INTERNAL_ROUTES_PREFIX = "/internal";
export const COLLAB_SOURCE_READ_PATH = "/documents/read";
export const COLLAB_SOURCE_WRITE_PATH = "/documents/write";
export const COLLAB_SOURCE_EDIT_PATH = "/documents/edit";
export const COLLAB_AGENT_ACTIVITY_PATH = "/documents/agent_activity";

export const collabSourceReadRequestSchema = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1).optional(),
  canonicalPath: z.string().min(1),
  agent: collabAgentSchema.optional(),
});

export type CollabSourceReadRequest = z.infer<
  typeof collabSourceReadRequestSchema
>;

/** What the collab server reports of a live document an agent wants to change. */
export const collabSourceReadResponseSchema = z.discriminatedUnion("open", [
  z.object({ open: z.literal(false) }),
  z.object({ open: z.literal(true), source: z.string() }),
]);

export type CollabSourceReadResponse = z.infer<
  typeof collabSourceReadResponseSchema
>;

// `unsaved`: refused, since the session's saves fail and the change would only live in memory.
export const COLLAB_SOURCE_WRITE_RESULTS = [
  "written",
  "changed",
  "closed",
  "busy",
  "unsaved",
] as const;

/** How long a write may wait for its turn on the collab server, kept below its caller's timeout. */
export const COLLAB_SOURCE_WRITE_WAIT_MS = 5 * 1000;

export type CollabSourceWriteResult =
  (typeof COLLAB_SOURCE_WRITE_RESULTS)[number];

export const collabSourceWriteRequestSchema =
  collabSourceReadRequestSchema.extend({
    userId: z.string().min(1),
    base: z.string(),
    source: z.string(),
  });

export type CollabSourceWriteRequest = z.infer<
  typeof collabSourceWriteRequestSchema
>;

export const collabSourceWriteResponseSchema = z.discriminatedUnion("result", [
  z.object({ result: z.enum(COLLAB_SOURCE_WRITE_RESULTS) }),
  z.object({ result: z.literal("refused"), message: z.string() }),
]);

export type CollabSourceWriteResponse = z.infer<
  typeof collabSourceWriteResponseSchema
>;

/** Why an edit does not apply to the session's current source, as `edit_document` reports it. */
export const COLLAB_EDIT_REFUSAL_CODES = [
  "string_not_found",
  "outside_body",
  "unexpected_count",
  "anchors_invalid",
  "too_large",
] as const;

export type CollabEditRefusalCode = (typeof COLLAB_EDIT_REFUSAL_CODES)[number];

/** An agent's find-and-replace, applied by the session to its source at its turn. */
export const collabSourceEditSchema = z.object({
  oldString: z.string(),
  newString: z.string(),
  expectedReplacements: z.number().int().positive(),
});

export type CollabSourceEdit = z.infer<typeof collabSourceEditSchema>;

export const collabSourceEditRequestSchema =
  collabSourceReadRequestSchema.extend({
    userId: z.string().min(1),
    edit: collabSourceEditSchema,
  });

export type CollabSourceEditRequest = z.infer<
  typeof collabSourceEditRequestSchema
>;

export const collabSourceEditResponseSchema = z.discriminatedUnion("result", [
  z.object({
    result: z.literal("written"),
    replacements: z.number().int().positive(),
  }),
  z.object({ result: z.enum(["closed", "busy", "unsaved"]) }),
  z.object({ result: z.literal("refused"), message: z.string() }),
  z.object({
    result: z.literal("edit_refused"),
    code: z.enum(COLLAB_EDIT_REFUSAL_CODES),
    message: z.string(),
  }),
]);

export type CollabSourceEditResponse = z.infer<
  typeof collabSourceEditResponseSchema
>;

/** An edit's answer once a refusal is turned into an error. */
export type CollabSourceEditResult = Exclude<
  CollabSourceEditResponse,
  { result: "refused" }
>;
export const collabAgentActivityRequestSchema = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  canonicalPath: z.string().min(1),
  agent: collabAgentSchema,
  activity: z.enum(AGENT_ACTIVITIES),
});

export type CollabAgentActivityRequest = z.infer<
  typeof collabAgentActivityRequestSchema
>;

export const collabAgentActivityResponseSchema = z.object({});
