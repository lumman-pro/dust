import { workspaceApp } from "@front-api/middlewares/ctx";

import frameId from "./[frameId]";

const app = workspaceApp();

app.route("/:frameId", frameId);

export default app;
