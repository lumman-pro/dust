import type { PokeListDfs } from "@app/lib/api/poke/dfs";
import { listPokeDfsChildren } from "@app/lib/api/poke/dfs";
import { isDfsObjectId } from "@app/types/dfs";
import { pokeApp } from "@front-api/middlewares/ctx";
import { apiError, type HandlerResult } from "@front-api/middlewares/utils";
import { validate } from "@front-api/middlewares/validator";
import { z } from "zod";

import objectId from "./[objectId]";

const QuerySchema = z.object({
  // The dfs folder to list; omitted for the tenant root.
  folderId: z.string().refine(isDfsObjectId).optional(),
});

// Mounted at /api/poke/workspaces/:wId/dfs.
const app = pokeApp();

/** @ignoreswagger */
app.get(
  "/",
  validate("query", QuerySchema),
  async (ctx): HandlerResult<PokeListDfs> => {
    const auth = ctx.get("auth");
    const { folderId } = ctx.req.valid("query");

    const listed = await listPokeDfsChildren(auth, {
      folderId: folderId && isDfsObjectId(folderId) ? folderId : undefined,
    });
    if (listed.isErr()) {
      return apiError(
        ctx,
        {
          status_code: 500,
          api_error: {
            type: "internal_server_error",
            message: `Failed to list the dfs folder: ${listed.error.message}`,
          },
        },
        listed.error
      );
    }

    return ctx.json(listed.value);
  }
);

app.route("/:objectId", objectId);

export default app;
