import { workspaceApp } from "@front-api/middlewares/ctx";

import resolveAuthentication from "./resolve-authentication";
import validateAction from "./validate-action";

const app = workspaceApp();

app.route("/resolve-authentication", resolveAuthentication);
app.route("/validate-action", validateAction);

export default app;
