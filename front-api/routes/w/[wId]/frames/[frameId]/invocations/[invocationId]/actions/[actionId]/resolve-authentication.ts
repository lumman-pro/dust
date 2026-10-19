import { resolveFrameFunctionInvocationForUse } from "@app/lib/api/sandbox_functions/frame_share_capability";
import { resolveSandboxFunctionActionAuthentication } from "@app/lib/api/sandbox_functions/resolve_authentication";
import { assertNever } from "@app/types/shared/utils/assert_never";
import {
  FrameFunctionInvocationActionParamsSchema,
  ResolveFrameFunctionAuthenticationBodySchema,
} from "@front-api/lib/api/frame_function_invocation_schemas";
import { workspaceApp } from "@front-api/middlewares/ctx";
import { apiError, type HandlerResult } from "@front-api/middlewares/utils";
import { validate } from "@front-api/middlewares/validator";

const app = workspaceApp();

/** @ignoreswagger */
app.post(
  "/",
  validate("param", FrameFunctionInvocationActionParamsSchema),
  validate("json", ResolveFrameFunctionAuthenticationBodySchema),
  async (ctx): HandlerResult<{ success: boolean }> => {
    const auth = ctx.get("auth");
    const { frameId, invocationId, actionId } = ctx.req.valid("param");
    const { outcome } = ctx.req.valid("json");

    const invocation = await resolveFrameFunctionInvocationForUse(auth, {
      frameId,
      invocationId,
    });
    if (!invocation) {
      return apiError(ctx, {
        status_code: 404,
        api_error: {
          type: "sandbox_function_invocation_not_found",
          message: "Frame function invocation not found.",
        },
      });
    }

    const result = await resolveSandboxFunctionActionAuthentication(auth, {
      sandboxFunction: invocation.sandboxFunction,
      invocationId: invocation.sId,
      actionId,
      outcome,
    });
    if (result.isErr()) {
      switch (result.error.type) {
        case "action_not_found":
          return apiError(ctx, {
            status_code: 404,
            api_error: {
              type: "action_not_found",
              message: result.error.message,
            },
          });
        case "action_not_blocked":
          // The client treats this error type as an already-resolved authentication (multi-client
          // races).
          return apiError(ctx, {
            status_code: 400,
            api_error: {
              type: "action_not_blocked",
              message: result.error.message,
            },
          });
        case "unauthorized":
          return apiError(ctx, {
            status_code: 403,
            api_error: {
              type: "sandbox_function_invocation_initiator_required",
              message: result.error.message,
            },
          });
        default:
          return assertNever(result.error.type);
      }
    }

    return ctx.json({ success: true });
  }
);

export default app;
