import { dfmCommentSchema, dfmCommentsSchema } from "@app/lib/markdown/dfm";
import { z } from "zod";

/** The Yjs fragment holding a live document's body, read by the server and bound by the editor. */
export const BODY_FRAGMENT_NAME = "body";

const DOCUMENT_NAME_SEPARATOR = ":";

// TODO(co-edition step 8): key on a stable file id. A rename during a session leaves editors on
// the old path, and saving there (step 9) would recreate the file.
/** The name a live document goes by on the WebSocket: workspace and file path. */
export function toSessionName(
  workspaceId: string,
  canonicalPath: string
): string {
  return `${workspaceId}${DOCUMENT_NAME_SEPARATOR}${canonicalPath}`;
}

export function parseSessionName(
  documentName: string
): { workspaceId: string; canonicalPath: string } | null {
  const index = documentName.indexOf(DOCUMENT_NAME_SEPARATOR);
  if (index <= 0 || index === documentName.length - 1) {
    return null;
  }
  return {
    workspaceId: documentName.slice(0, index),
    canonicalPath: documentName.slice(index + 1),
  };
}

/**
 * Comment threads in a live session travel beside the shared document, as Hocuspocus stateless
 * messages: the browser sends commands, the server answers each one and pushes every change of
 * the threads to all the document's browsers.
 */

const commentIdSchema = z.string().min(1);

const yIdSchema = z.object({
  client: z.number().int().nonnegative(),
  clock: z.number().int().nonnegative(),
});

/** A Yjs relative position right after a character, as `Y.relativePositionToJSON` writes it. */
const relativePositionSchema = z.object({
  item: yIdSchema,
  assoc: z.literal(-1),
});

/**
 * The text a new thread anchors to, by the relative positions right after its first and last
 * characters a comment mark can sit on, so it follows the edits made while the command travels.
 */
export const commentAnchorSchema = z.object({
  first: relativePositionSchema,
  last: relativePositionSchema,
});

export type CommentAnchor = z.infer<typeof commentAnchorSchema>;

export const commentRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add"),
    commentId: commentIdSchema,
    body: z.string().min(1),
    // The text the thread anchors to, which agents get as the quote.
    quote: z.string().optional(),
    // TODO(co-edition): require it once no browser anchors its threads itself.
    // The session marks it; without it, the browser anchors the thread once accepted.
    anchor: commentAnchorSchema.optional(),
  }),
  z.object({
    type: z.literal("reply"),
    commentId: commentIdSchema,
    position: z.number().int().min(1),
    body: z.string().min(1),
  }),
  z.object({
    type: z.literal("resolve"),
    commentId: commentIdSchema,
    resolved: z.boolean(),
  }),
  z.object({ type: z.literal("delete"), commentId: commentIdSchema }),
]);

export type CommentRequest = z.infer<typeof commentRequestSchema>;

export const commentClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("threads") }),
  z.object({
    type: z.literal("command"),
    requestId: z.string().min(1),
    command: commentRequestSchema,
  }),
]);

export type CommentClientMessage = z.infer<typeof commentClientMessageSchema>;

export const COMMENT_REQUEST_ERROR_CODES = [
  "unavailable",
  "not_found",
  "thread_changed",
  "unwritable",
  "unanchored",
] as const;

export type CommentRequestErrorCode =
  (typeof COMMENT_REQUEST_ERROR_CODES)[number];

export const commentServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("threads"), comments: dfmCommentsSchema }),
  z.object({
    type: z.literal("accepted"),
    requestId: z.string(),
    comment: dfmCommentSchema.nullable(),
  }),
  z.object({
    type: z.literal("refused"),
    requestId: z.string(),
    error: z.enum(COMMENT_REQUEST_ERROR_CODES),
  }),
]);

export type CommentServerMessage = z.infer<typeof commentServerMessageSchema>;

/**
 * The agent at work in a live document, the user it works for and, when a comment mentioned it,
 * the thread it answers, as editors show them.
 */
export const collabAgentSchema = z.object({
  agentId: z.string().min(1),
  name: z.string().min(1),
  userId: z.string().min(1).nullable().default(null),
  userName: z.string().default(""),
  commentId: z.string().min(1).nullable().default(null),
});

export type CollabAgent = z.infer<typeof collabAgentSchema>;

/**
 * What an agent is doing in a live document, pushed to its editors as a stateless message.
 * `editing` goes out just before the agent's change is applied: Hocuspocus may batch document
 * updates but sends stateless messages at once, so an editor receives it first. An agent a comment
 * mentioned is `waiting` while another run holds its conversation, then `thinking` until its
 * reply in the thread.
 */
export const AGENT_ACTIVITIES = [
  "waiting",
  "thinking",
  "reading",
  "editing",
] as const;

export type AgentActivity = (typeof AGENT_ACTIVITIES)[number];

export type WorkingAgentActivity = Exclude<AgentActivity, "waiting">;

export type DocumentActivity = Extract<AgentActivity, "reading" | "editing">;

export const isDocumentActivity = (
  activity: AgentActivity
): activity is DocumentActivity =>
  activity === "reading" || activity === "editing";

export const agentActivityMessageSchema = z.object({
  type: z.literal("agent_activity"),
  agent: collabAgentSchema,
  activity: z.enum(AGENT_ACTIVITIES),
});

export type AgentActivityMessage = z.infer<typeof agentActivityMessageSchema>;

/** Yjs items by id: `length` consecutive clocks of `client`, from `clock`. */
const insertedIdRangeSchema = z.object({
  client: z.number().int().nonnegative(),
  clock: z.number().int().nonnegative(),
  length: z.number().int().positive(),
});

export type InsertedIdRange = z.infer<typeof insertedIdRangeSchema>;

/** One range per client a change advances: an agent's change holds one, other ranges are noise. */
const AGENT_EDIT_MAX_RANGES = 16;

/**
 * The text an agent's change inserted in a live document, by Yjs item ids, so editors highlight
 * exactly that text and no one else's. Sent right after the change's update.
 */
export const agentEditMessageSchema = z.object({
  type: z.literal("agent_edit"),
  agent: collabAgentSchema,
  inserted: z.array(insertedIdRangeSchema).max(AGENT_EDIT_MAX_RANGES),
});

export type AgentEditMessage = z.infer<typeof agentEditMessageSchema>;

/** How the collab server stands saving a live document to its file, as its editors show it. */
export const saveStateSchema = z.object({
  /** Its last save failed. */
  failed: z.boolean(),
  /**
   * Where the file's version was last kept, after the file changed outside the live document and
   * the document saved over it. Absent from older servers.
   */
  conflictCopy: z.string().min(1).nullable().default(null),
});

export type SaveState = z.infer<typeof saveStateSchema>;

/** Nothing to show: the state of a document whose saves succeed. */
export const DEFAULT_SAVE_STATE: SaveState = {
  failed: false,
  conflictCopy: null,
};

/** Whether `state` has nothing to show, every field as in `DEFAULT_SAVE_STATE`. */
export const isDefaultSaveState = (state: SaveState): boolean =>
  !state.failed && state.conflictCopy === null;

/**
 * The whole save state, sent to every editor when it changes, and to each editor that connects
 * while it differs from `DEFAULT_SAVE_STATE`.
 */
export const saveStateMessageSchema = saveStateSchema.extend({
  type: z.literal("save_state"),
});

export type SaveStateMessage = z.infer<typeof saveStateMessageSchema>;

/**
 * The Yjs history of the server's document, sent to each editor once connected. It changes only
 * when the server builds the document from its file again, giving its text new Yjs ids.
 */
export const epochMessageSchema = z.object({
  type: z.literal("epoch"),
  epoch: z.string().min(1),
});

export type EpochMessage = z.infer<typeof epochMessageSchema>;

/**
 * What an editor authenticates with once it kept its document from an earlier connection: its
 * ticket and that document's epoch. An editor with no document kept sends its ticket alone.
 */
export const collabTokenSchema = z.object({
  ticket: z.string().min(1),
  epoch: z.string().min(1),
});

export type CollabToken = z.infer<typeof collabTokenSchema>;

/** Why the server closes a connection whose kept document has another epoch than its own. */
export const EPOCH_CHANGED_CLOSE_REASON = "epoch_changed";
