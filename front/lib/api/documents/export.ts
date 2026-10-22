import {
  DfmStoredDocumentError,
  readCurrentDocumentSource,
} from "@app/lib/api/documents/read_write";
import type { DustFileSystem } from "@app/lib/api/file_system/dust_file_system";
import type { Authenticator } from "@app/lib/auth";
import { parseDfmWithAnchors } from "@app/lib/markdown/dfm";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";

/** `dfm` keeps the document's comments, `markdown` drops them. */
export type DocumentExportFormat = "dfm" | "markdown";

/** The document as its editors see it, live while a session holds it. */
export async function exportDocument(
  auth: Authenticator,
  dustFs: DustFileSystem,
  scopedPath: string,
  format: DocumentExportFormat
): Promise<Result<string, DfmStoredDocumentError>> {
  const read = await readCurrentDocumentSource(auth, dustFs, scopedPath);
  if (read.isErr()) {
    return read;
  }
  if (format === "dfm") {
    return new Ok(read.value.source);
  }

  const parsed = parseDfmWithAnchors(read.value.source);
  if (parsed.isErr()) {
    return new Err(
      new DfmStoredDocumentError("invalid_document", parsed.error.message)
    );
  }
  // The body alone, as the document shows it: no front matter, comment anchors or threads.
  const body = parsed.value.anchors.text;
  return new Ok(body === "" ? "" : `${body}\n`);
}
