import { listConversationBlockedActions } from "@app/lib/api/assistant/conversation/blocked_actions";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import type { BlockedActionsResponseType } from "@dust-tt/client";
import { publicApiApp } from "@front-api/middlewares/ctx";
import type { HandlerResult } from "@front-api/middlewares/utils";
import { apiError } from "@front-api/middlewares/utils";
import { validate } from "@front-api/middlewares/validator";
import { z } from "zod";

const ParamsSchema = z.object({
  cId: z.string(),
});

// Mounted at /api/v1/w/:wId/assistant/conversations/:cId/actions/blocked.
const app = publicApiApp();

/**
 * @ignoreswagger
 */
app.get(
  "/",
  validate("param", ParamsSchema),
  async (ctx): HandlerResult<BlockedActionsResponseType> => {
    const auth = ctx.get("auth");
    const { cId } = ctx.req.valid("param");

    const conversation = await ConversationResource.fetchById(auth, cId);

    if (!conversation) {
      return apiError(ctx, {
        status_code: 404,
        api_error: {
          type: "conversation_not_found",
          message: "Conversation not found.",
        },
      });
    }

    const blockedActions = await listConversationBlockedActions(
      auth,
      conversation
    );

    return ctx.json({ blockedActions });
  }
);

export default app;
