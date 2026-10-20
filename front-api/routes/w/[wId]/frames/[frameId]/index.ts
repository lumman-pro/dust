import { workspaceApp } from "@front-api/middlewares/ctx";

import authorizedFiles from "./authorized-files";
import draftMode from "./draft-mode";
import functions from "./functions";
import invocations from "./invocations";
import makeLive from "./make-live";
import permissions from "./permissions";
import source from "./source";
import toolAuthorizations from "./tool-authorizations";

const app = workspaceApp();

app.route("/authorized-files", authorizedFiles);
app.route("/draft-mode", draftMode);
app.route("/functions", functions);
app.route("/invocations", invocations);
app.route("/make-live", makeLive);
app.route("/permissions", permissions);
app.route("/source", source);
app.route("/tool-authorizations", toolAuthorizations);

export default app;
