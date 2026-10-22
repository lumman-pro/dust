import { serializeDocumentHtml } from "@app/components/editor/document/content";
import {
  loadDfm,
  loggableRefusal,
} from "@app/components/editor/document/dfm_persistence";
import {
  withoutDocumentJSONComments,
  withoutOrphanCommentMarks,
} from "@app/components/editor/document/DocumentComments";
import config from "@app/lib/api/config";
import type { DfmStoredDocumentError } from "@app/lib/api/documents/read_write";
import { readCurrentDocumentSource } from "@app/lib/api/documents/read_write";
import type { DustFileSystem } from "@app/lib/api/file_system/dust_file_system";
import {
  PDF_FOOTER_HTML,
  shouldShowPdfFooter,
} from "@app/lib/api/files/pdf_footer";
import type { Authenticator } from "@app/lib/auth";
import logger from "@app/logger/logger";
import { stripFileExtension } from "@app/types/files";
import type { PdfOptions } from "@app/types/shared/document_renderer";
import { DocumentRenderer } from "@app/types/shared/document_renderer";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { escapeXml } from "@app/types/shared/utils/string_utils";
import path from "path";

export type DocumentPdfExportErrorCode =
  | "not_configured"
  | "not_exportable"
  | "render_failed";

export class DocumentPdfExportError extends Error {
  constructor(
    readonly code: DocumentPdfExportErrorCode,
    message: string
  ) {
    super(message);
    this.name = "DocumentPdfExportError";
  }
}

export function isDocumentPdfExportError(
  error: unknown
): error is DocumentPdfExportError {
  return error instanceof DocumentPdfExportError;
}

// The editor's Tailwind classes ride along unstyled. Chromium's default stylesheet styles the
// elements; these rules only fix what it gets wrong for the editor's HTML.
// TODO(louisjc): print with the editor's own styles once its CSS can be built for the server.
const DOCUMENT_PDF_STYLE = `
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.5; }
li > p, td > p { margin: 0; }
li[data-task] { list-style-type: "☐  "; }
li[data-checked] { list-style-type: "☑  "; }
pre { white-space: pre-wrap; }
table { border-collapse: collapse; }
td { border: 1px solid #d1d5db; padding: 4px 8px; vertical-align: top; }
[data-document-frame] { padding: 16px; border: 1px dashed #d1d5db; color: #6b7280; }
`;

// Override the renderer defaults, which print Frames full-bleed at 80% scale.
const DOCUMENT_PDF_OPTIONS: PdfOptions = {
  marginTop: "2cm",
  marginBottom: "2cm",
  marginLeft: "2cm",
  marginRight: "2cm",
  scale: 1,
};

/**
 * The document body as a printable HTML page: no front matter, comment threads or comment marks.
 * A source `loadDfm` refuses is refused with `not_exportable`, its reason as `loggableRefusal`
 * gives it.
 */
export function renderDocumentHtml(
  source: string,
  title: string
): Result<string, DocumentPdfExportError> {
  const loaded = loadDfm(source);
  if (loaded.isErr()) {
    // The route logs the message.
    return new Err(
      new DocumentPdfExportError(
        "not_exportable",
        loggableRefusal(loaded.error)
      )
    );
  }

  const content = withoutOrphanCommentMarks(
    withoutDocumentJSONComments(loaded.value.content),
    new Set()
  );
  const body = serializeDocumentHtml(content);

  // Gotenberg's Chromium loads nothing and runs no script from the document.
  return new Ok(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>${escapeXml(title)}</title>
  <style>${DOCUMENT_PDF_STYLE}</style>
</head>
<body>
${body}
</body>
</html>`);
}

/** The document printed to PDF as its editors see it, live while a session holds it. */
export async function exportDocumentAsPdf(
  auth: Authenticator,
  dustFs: DustFileSystem,
  scopedPath: string
): Promise<
  Result<
    { buffer: Buffer; fileName: string },
    DfmStoredDocumentError | DocumentPdfExportError
  >
> {
  const documentRendererUrl = config.getDocumentRendererUrl();
  if (!documentRendererUrl) {
    return new Err(
      new DocumentPdfExportError(
        "not_configured",
        "PDF export is not configured."
      )
    );
  }

  const read = await readCurrentDocumentSource(auth, dustFs, scopedPath);
  if (read.isErr()) {
    return read;
  }

  const baseName = stripFileExtension(path.posix.basename(scopedPath));
  const html = renderDocumentHtml(read.value.source, baseName);
  if (html.isErr()) {
    return html;
  }

  const options: PdfOptions = {
    ...DOCUMENT_PDF_OPTIONS,
    ...(shouldShowPdfFooter(auth) ? { footerHtml: PDF_FOOTER_HTML } : {}),
  };
  const renderer = new DocumentRenderer(documentRendererUrl, logger);
  const pdf = await renderer.exportHtmlToPdf(html.value, options);
  if (pdf.isErr()) {
    return new Err(
      new DocumentPdfExportError("render_failed", "Failed to generate PDF.")
    );
  }

  return new Ok({ buffer: pdf.value, fileName: `${baseName}.pdf` });
}
