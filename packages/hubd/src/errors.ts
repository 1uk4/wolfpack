import type { ErrorCode } from "@wolfpack/protocol";

/** An error with a protocol code; the server turns it into the error envelope. */
export class HubError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly details?: Record<string, string>) {
    super(message);
  }
}
