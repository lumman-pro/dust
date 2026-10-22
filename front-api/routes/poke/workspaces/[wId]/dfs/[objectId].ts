import type { PokeDfsObject } from "@app/lib/api/poke/dfs";
import { getPokeDfsObject } from "@app/lib/api/poke/dfs";
import { isDfsObjectId } from "@app/types/dfs";
import { pokeApp } from "@front-api/middlewares/ctx";
import { apiError, type HandlerResult } from "@front-api/middlewares/utils";
import { validate } from "@front-api/middlewares/validator";
import { z } from "zod";

const ParamsSchema = z.object({
  objectId: z.string().refine(isDfsObjectId),
});

const QuerySchema = z.object({
  // Comma-separated ancestors of the object, from the tenant root down to its parent.
  ancestorIds: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",") : []))
    .refine((ids) => ids.every(isDfsObjectId)),
});

// Mounted at /api/poke/workspaces/:wId/dfs/:objectId.
const app = pokeApp();

/** @ignoreswagger */
app.get(
  "/",
  validate("param", ParamsSchema),
  validate("query", QuerySchema),
  async (ctx): HandlerResult<PokeDfsObject> => {
    const auth = ctx.get("auth");
    const { objectId } = ctx.req.valid("param");
    const { ancestorIds } = ctx.req.valid("query");
    if (!isDfsObjectId(objectId)) {
      return apiError(ctx, {
        status_code: 400,
        api_error: {
          type: "invalid_request_error",
          message: "Invalid dfs object ID.",
        },
      });
    }

    const object = await getPokeDfsObject(auth, objectId, {
      ancestorIds: ancestorIds.filter(isDfsObjectId),
    });
    if (object.isErr()) {
      return apiError(
        ctx,
        {
          status_code: 500,
          api_error: {
            type: "internal_server_error",
            message: `Failed to read the dfs object: ${object.error.message}`,
          },
        },
        object.error
      );
    }

    return ctx.json(object.value);
  }
);

export default app;
