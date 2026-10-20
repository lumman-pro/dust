import {
  applyAgentEdit,
  DfmAgentDocumentError,
} from "@app/lib/api/documents/agent_edit_source";
import type { DfmStoredDocumentError } from "@app/lib/api/documents/read_write";
import {
  editLiveDocument,
  readCurrentDocumentSource,
  writeDocumentChange,
} from "@app/lib/api/documents/read_write";
import type { DustFileSystem } from "@app/lib/api/file_system/dust_file_system";
import type { Authenticator } from "@app/lib/auth";
import type { CollabAgent } from "@app/types/collab";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { assertNever } from "@app/types/shared/utils/assert_never";

/**
 * @cc [owner:tdraier,label:product] dfm-agent-document-read
 * Reading MUST return the full DFM source of the document that `editAgentDocument` matches
 * against, front matter, comment anchors and annotations block included, as
 * `readCurrentDocumentSource` returns it: the live session's while one holds the document.
 */
export async function readAgentDocument(
  auth: Authenticator,
  dustFs: DustFileSystem,
  scopedPath: string,
  agent?: CollabAgent
): Promise<Result<{ source: string }, DfmStoredDocumentError>> {
  return readCurrentDocumentSource(auth, dustFs, scopedPath, agent);
}

/**
 * @cc [owner:tdraier,label:product;concurrency] dfm-agent-document-edit
 * An edit MUST replace exactly `expectedReplacements` occurrences of `oldString` in the body of
 * the source `readAgentDocument` returns, or, with an empty `oldString`, write `newString` as
 * the body of a document whose body is empty or blank, and refuse an empty `oldString` otherwise
 * or with `expectedReplacements` other than 1.
 * Line breaks in the source and `oldString` MUST be matched normalized to `\n`, so a passage
 * quoted from a CRLF source still matches; they MAY be normalized to `\n` and trailing ones
 * dropped from the edited body. It MUST leave the front matter and the comment threads unchanged,
 * and refuse with `anchors_invalid` an edit that adds anchors or breaks a pair. It MAY remove
 * whole anchor pairs, keeping their threads. While a live session holds the document, the session
 * MUST apply it to its source at its turn (`editLiveDocument`), so changes made since the agent's
 * call do not refuse it; otherwise it MUST be written through `writeDocumentChange`.
 */
export async function editAgentDocument(
  auth: Authenticator,
  dustFs: DustFileSystem,
  {
    scopedPath,
    oldString,
    newString,
    expectedReplacements,
    agent,
  }: {
    scopedPath: string;
    oldString: string;
    newString: string;
    expectedReplacements: number;
    agent?: CollabAgent;
  }
): Promise<
  Result<
    { replacements: number },
    DfmAgentDocumentError | DfmStoredDocumentError
  >
> {
  const edit = { oldString, newString, expectedReplacements };
  // TODO(co-edition): pass an idempotency key so a retried tool call is applied once.
  const live = await editLiveDocument(auth, dustFs, scopedPath, edit, agent);
  if (live.isErr()) {
    return live;
  }
  switch (live.value.kind) {
    case "written":
      return new Ok(live.value.value);
    case "edit_refused":
      return new Err(
        new DfmAgentDocumentError(live.value.code, live.value.message)
      );
    case "no_session":
      return writeDocumentChange(
        auth,
        dustFs,
        scopedPath,
        async (read) => applyAgentEdit(read, edit),
        agent
      );
    default:
      return assertNever(live.value);
  }
}
