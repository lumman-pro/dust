import type { PokeDfsObject, PokeListDfs } from "@app/lib/api/poke/dfs";
import { getPokeDfsObject, listPokeDfsChildren } from "@app/lib/api/poke/dfs";
import { isDfsObjectId } from "@app/types/dfs";
import { pokeApp } from "@front-api/middlewares/ctx";
import { apiError, type HandlerResult } from "@front-api/middlewares/utils";
import { validate } from "@front-api/middlewares/validator";
import { z } from "zod";

const QuerySchema = z.object({
  // A dfs folder ID; omitted for the tenant root.
  parentId: z.string().refine(isDfsObjectId).optional(),
});

const ParamsSchema = z.object({
  objectId: z.string().refine(isDfsObjectId),
});

const ObjectQuerySchema = z.object({
  // Comma-separated ancestors of the object, from the tenant root down to its parent.
  ancestorIds: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",") : []))
    .refine((ids) => ids.every(isDfsObjectId)),
});

// Mounted at /api/poke/workspaces/:wId/dfs.
const app = pokeApp();

/** @ignoreswagger */
app.get(
  "/",
  validate("query", QuerySchema),
  async (ctx): HandlerResult<PokeListDfs> => {
    const auth = ctx.get("auth");
    const { parentId } = ctx.req.valid("query");

    const listed = await listPokeDfsChildren(auth, {
      parentId: parentId && isDfsObjectId(parentId) ? parentId : undefined,
    });
    if (listed.isErr()) {
      return apiError(ctx, {
        status_code: 500,
        api_error: {
          type: "internal_server_error",
          message: `Failed to list the dfs folder: ${listed.error.message}`,
        },
      });
    }

    return ctx.json(listed.value);
  }
);

/** @ignoreswagger */
app.get(
  "/:objectId",
  validate("param", ParamsSchema),
  validate("query", ObjectQuerySchema),
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
      return apiError(ctx, {
        status_code: 500,
        api_error: {
          type: "internal_server_error",
          message: `Failed to read the dfs object: ${object.error.message}`,
        },
      });
    }

    return ctx.json(object.value);
  }
);

export default app;
