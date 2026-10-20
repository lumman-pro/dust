import {
  DfmStoredDocumentError,
  editLiveDocument,
  readCurrentDocumentSource,
  writeDocumentChange,
} from "@app/lib/api/documents/read_write";
import type { DustFileSystem } from "@app/lib/api/file_system/dust_file_system";
import type { Authenticator } from "@app/lib/auth";
import type { DfmDocument } from "@app/lib/markdown/dfm";
import { extractAnchors, parseDfm, serializeDfm } from "@app/lib/markdown/dfm";
import type { CollabAgent } from "@app/types/collab";
import type {
  CollabEditRefusalCode,
  CollabSourceEdit,
} from "@app/types/collab_internal";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { assertNever } from "@app/types/shared/utils/assert_never";

export type DfmAgentDocumentErrorCode = CollabEditRefusalCode;

export class DfmAgentDocumentError extends Error {
  constructor(
    readonly code: DfmAgentDocumentErrorCode,
    message: string
  ) {
    super(message);
  }
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  for (
    let index = text.indexOf(search);
    index !== -1;
    index = text.indexOf(search, index + search.length)
  ) {
    count++;
  }
  return count;
}

function replaceInBody({
  text,
  body,
  oldString,
  newString,
  expectedReplacements,
}: {
  text: string;
  body: string;
  oldString: string;
  newString: string;
  expectedReplacements: number;
}): Result<
  { editedBody: string; replacements: number },
  DfmAgentDocumentError
> {
  // An empty `oldString` matches nowhere and everywhere, so it only writes an empty body.
  if (oldString === "") {
    if (expectedReplacements !== 1) {
      return new Err(
        new DfmAgentDocumentError(
          "unexpected_count",
          `Expected ${expectedReplacements} replacements, but an empty text to replace makes exactly one.`
        )
      );
    }
    return body.trim() === ""
      ? new Ok({ editedBody: newString, replacements: 1 })
      : new Err(
          new DfmAgentDocumentError(
            "string_not_found",
            "The text to replace can only be empty when the document body is empty."
          )
        );
  }

  const occurrences = countOccurrences(body, oldString);
  if (occurrences === 0) {
    return new Err(
      countOccurrences(text, oldString) > 0
        ? new DfmAgentDocumentError(
            "outside_body",
            "The text to replace is outside the document body. Only the body can be edited; " +
              "use the comment tools for comment threads."
          )
        : new DfmAgentDocumentError(
            "string_not_found",
            "The text to replace was not found. The document may have changed: read it again " +
              "and retry with its exact current text."
          )
    );
  }
  if (occurrences !== expectedReplacements) {
    return new Err(
      new DfmAgentDocumentError(
        "unexpected_count",
        `Expected ${expectedReplacements} replacements, but found ${occurrences} occurrences.`
      )
    );
  }

  // `split`/`join` rather than `replaceAll`, which would expand `$&`-style patterns in newString.
  return new Ok({
    editedBody: body.split(oldString).join(newString),
    replacements: occurrences,
  });
}

function anchorIds(body: string): Set<string> | null {
  const anchors = extractAnchors(body);
  return anchors.isOk()
    ? new Set(anchors.value.anchors.map(({ id }) => id))
    : null;
}

/** `edit` applied to a document read as `text`, as `dfm-agent-document-edit` describes it. */
function applyAgentEdit(
  { text, document }: { text: string; document: DfmDocument },
  { oldString, newString, expectedReplacements }: CollabSourceEdit
): Result<
  { document: DfmDocument; value: { replacements: number } },
  DfmAgentDocumentError
> {
  // The codec normalizes the body's line breaks to `\n`, so a passage quoted from a source
  // stored with CRLF line endings only matches once normalized the same way.
  const replaced = replaceInBody({
    text: text.replaceAll("\r\n", "\n"),
    body: document.body,
    oldString: oldString.replaceAll("\r\n", "\n"),
    newString,
    expectedReplacements,
  });
  if (replaced.isErr()) {
    return replaced;
  }
  const { replacements } = replaced.value;
  // The codec refuses carriage returns and a body ending with a line break, which agents
  // often write; neither changes the rendered document.
  const editedBody = replaced.value.editedBody
    .replaceAll("\r\n", "\n")
    .replace(/\n+$/, "");

  // Removing a whole pair is allowed, as when people delete commented text in the editor:
  // its thread stays in the annotations block, without an anchor.
  const anchorsBefore = anchorIds(document.body);
  const anchorsAfter = anchorIds(editedBody);
  if (
    anchorsAfter === null ||
    anchorsBefore === null ||
    !anchorsAfter.isSubsetOf(anchorsBefore)
  ) {
    return new Err(
      new DfmAgentDocumentError(
        "anchors_invalid",
        "The edit would add or break `:comment-start{…}` / `:comment-end{…}` anchors. " +
          "Edit the text inside an anchor pair, or delete it together with both anchors. " +
          "Never leave one anchor without the other, and never write new ones."
      )
    );
  }

  return new Ok({
    document: { ...document, body: editedBody },
    value: { replacements },
  });
}

/** `edit` applied to `source`, for a live session to apply it to its current source. */
export function editDocumentSource(
  source: string,
  edit: CollabSourceEdit
): Result<
  { source: string; replacements: number },
  DfmAgentDocumentError | DfmStoredDocumentError
> {
  const document = parseDfm(source);
  if (document.isErr()) {
    return new Err(
      new DfmStoredDocumentError("invalid_document", document.error.message)
    );
  }
  const edited = applyAgentEdit(
    { text: source, document: document.value },
    edit
  );
  if (edited.isErr()) {
    return edited;
  }
  const serialized = serializeDfm(edited.value.document);
  if (serialized.isErr()) {
    return new Err(
      new DfmStoredDocumentError("invalid_document", serialized.error.message)
    );
  }
  return new Ok({
    source: serialized.value,
    replacements: edited.value.value.replacements,
  });
}

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
