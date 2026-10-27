/**
 * Attachment constants, dependency-free on purpose: browser code imports this subpath
 * (`@wolfpack/protocol/attachments`) without pulling in zod or the rest of the protocol.
 */

/** Optional upload header: the URL-encoded original file name. */
export const ATTACHMENT_NAME_HEADER = "X-Attachment-Name";
/** Image types the wolf accepts as attachments for now (the upload route itself is type-agnostic). */
export const ATTACHMENT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
/** Upload size cap in bytes (the model providers refuse images over ~5 MB). */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
/** Most attachments one submit may reference. */
export const ATTACHMENT_MAX_PER_SUBMIT = 8;
