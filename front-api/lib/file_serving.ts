import { getFileFormat, normalizeMimeType } from "@app/types/files";

export function isContentTypeSafeToDisplay(contentType: string): boolean {
  return (
    getFileFormat(normalizeMimeType(contentType))?.isSafeToDisplay ?? false
  );
}

export function contentDispositionAttachment(fileName: string): string {
  const asciiFallback = fileName.replace(/[^\x20-\x7E\/\\]/g, "_");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function pdfAttachmentResponse(
  buffer: Buffer,
  fileName: string
): Response {
  // Convert Node `Buffer` to `Uint8Array` so it satisfies `BodyInit`.
  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": contentDispositionAttachment(fileName),
      "Content-Length": String(buffer.length),
    },
  });
}
