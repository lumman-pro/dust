import { workspaceApp } from "@front-api/middlewares/ctx";

import actionId from "./[actionId]";

const app = workspaceApp();

app.route("/:actionId", actionId);

export default app;
