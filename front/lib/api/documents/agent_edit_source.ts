import type { DfmDocument } from "@app/lib/markdown/dfm";
import {
  extractAnchors,
  INPUT_LIMITS,
  parseDfm,
  serializeDfm,
} from "@app/lib/markdown/dfm";
import type {
  CollabEditRefusalCode,
  CollabSourceEdit,
} from "@app/types/collab_internal";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";

// Twice what the codec reads: an edit is only refused here when it could never fit, unless it
// ends with more line breaks than the codec reads, which are dropped.
const MAX_BUILT_BODY_LENGTH = 2 * INPUT_LIMITS.length;

/** Why an edit is refused when its document would be too large to read or save. */
export const EDIT_TOO_LARGE_MESSAGE =
  "The edit would make the document too large. Make a smaller change.";

export class DfmAgentDocumentError extends Error {
  constructor(
    // The codes are defined with the collab server's answers, which carry them.
    readonly code: CollabEditRefusalCode,
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
    if (body.trim() !== "") {
      return new Err(
        new DfmAgentDocumentError(
          "string_not_found",
          "The text to replace can only be empty when the document body is empty."
        )
      );
    }
    return new Ok({ editedBody: newString, replacements: 1 });
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
  // Bounded before building it, so a short text replaced many times cannot take the process's
  // memory. Loose on purpose: the exact size is checked once line breaks are normalized.
  if (
    body.length + occurrences * (newString.length - oldString.length) >
    MAX_BUILT_BODY_LENGTH
  ) {
    return new Err(
      new DfmAgentDocumentError("too_large", EDIT_TOO_LARGE_MESSAGE)
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
export function applyAgentEdit(
  { text, document }: { text: string; document: DfmDocument },
  { oldString, newString, expectedReplacements }: CollabSourceEdit
): Result<
  { document: DfmDocument; value: { replacements: number } },
  DfmAgentDocumentError
> {
  // The codec normalizes the body's line breaks to `\n`, so a passage quoted from a source
  // stored with CRLF line endings only matches once normalized the same way. The replacement is
  // normalized too, so the size checks count the text that is written.
  const replaced = replaceInBody({
    text: text.replaceAll("\r\n", "\n"),
    body: document.body,
    oldString: oldString.replaceAll("\r\n", "\n"),
    newString: newString.replaceAll("\r\n", "\n"),
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

  // The codec bounds the source as written after its front matter: the threads, then the body
  // with the blank line before them, or with the line break after it when it is alone.
  const withoutBody = serializeDfm({
    ...document,
    frontMatter: null,
    body: "",
  });
  if (withoutBody.isOk() && editedBody !== "") {
    const rest = withoutBody.value === "" ? 1 : withoutBody.value.length + 2;
    if (editedBody.length + rest > INPUT_LIMITS.length) {
      return new Err(
        new DfmAgentDocumentError("too_large", EDIT_TOO_LARGE_MESSAGE)
      );
    }
  }

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

/** Why `editDocumentSource` changed nothing: the edit does not match, or the codec refuses. */
export type EditSourceFailure =
  | { kind: "edit_refused"; error: DfmAgentDocumentError }
  | { kind: "failed"; message: string };

/** `edit` applied to `source`, for a live session to apply it to its current source. */
export function editDocumentSource(
  source: string,
  edit: CollabSourceEdit
): Result<{ source: string; replacements: number }, EditSourceFailure> {
  const document = parseDfm(source);
  if (document.isErr()) {
    return new Err({ kind: "failed", message: document.error.message });
  }
  const edited = applyAgentEdit(
    { text: source, document: document.value },
    edit
  );
  if (edited.isErr()) {
    return new Err({ kind: "edit_refused", error: edited.error });
  }
  const { document: editedDocument, value } = edited.value;
  const serialized = serializeDfm(editedDocument);
  if (serialized.isErr()) {
    return new Err({ kind: "failed", message: serialized.error.message });
  }
  return new Ok({
    source: serialized.value,
    replacements: value.replacements,
  });
}
