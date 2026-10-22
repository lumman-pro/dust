# The collab server

The collab server (front-collab) is one Node process, started by `server.ts` and built from
front-api's code. On one port it serves browsers' WebSockets through Hocuspocus (`/api/collab`) and
front's internal HTTP calls (`/internal`). All of its own code is in this folder, from Hocuspocus
to loading and saving files (`collab-server-folder`); front-api's own server never imports from it.

It also runs code the rest of the app uses, which lives in front: access checks and the Yjs
document format (`front/lib/api/collab/`), the editor schema (`front/components/editor/document/`)
and the DFM codec (`front/lib/markdown/dfm/`).

| Path | What it does |
|---|---|
| `server.ts` | Starts the server: Hocuspocus, WebSocket upgrades, the HTTP routes, shutdown. |
| `lib/hocuspocus.ts` | Builds Hocuspocus and its hooks: connect, load, change, save, unload. Parses and answers browsers' comment messages. Saves every session on shutdown (`saveAllSessions`). |
| `lib/session.ts` | What the server holds for each open file (`CollabSession`), and reading and writing its source for front. |
| `lib/connection_access.ts` | Who may stay connected: checked when a browser connects, then every 5 minutes. |
| `lib/session_file.ts` | Loads a session from its file and saves it back, keeping a copy on a save conflict. |
| `lib/ydoc_state.ts` | The Yjs state kept in Redis between saves, so a reload keeps its Yjs ids. |
| `lib/comments.ts` | Applies a browser's comment request to a session, and dispatches the mentions in it. |
| `lib/internal_routes.ts` | The HTTP routes only front can call (agent tools, file uploads), built by `createInternalRoutes`. They call `session.ts`. |

`CollabAccessError` to HTTP errors (`front-api/lib/collab_access_errors.ts`) sits outside this
folder: front-api's collab ticket route uses it too.

Words, used the same way in code, contracts and docs (`x/daph/co-edition/ARCHITECTURE.md`):
co-edition is the feature, collab the code, and the UI says "live". A **file** is the `.md` in
storage, its **source** its Markdown, a **session** what this server holds for an open file, a
**connection** a browser's WebSocket, **access** a user's right to use a file here, and to **save**
is to write a session back to its file.
