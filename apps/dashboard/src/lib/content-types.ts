/**
 * File extension → MIME type mapping for the document upload feature.
 * Kept in a pure module (no CF deps) so tests can import it without
 * a cloudflare:workers shim.
 */

/** Maps file extension → MIME type for the upload route. */
export const EXT_TO_CONTENT_TYPE: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  html: "text/html",
  htm: "text/html",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
}
