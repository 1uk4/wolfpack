import type { ErrorCode } from "@wolfpack/protocol";

export class HttpError extends Error {
  /** `drain`: bytes of the request body already consumed; the server discards the rest (bounded) so the client can read this error. */
  constructor(readonly code: ErrorCode, message: string, readonly drain?: number, readonly details?: Record<string, string>) {
    super(message);
  }
}
