/**
 * Typed adapter failures. The sweep's classifyError (kb/librarian/backoff.ts)
 * reads `errorClass` / `parkNow` so it never has to guess from message text.
 */

/** The LLM transport is unavailable (limit hit, auth, spawn, network): back off, don't count against the item. */
export class LlmInfraError extends Error {
  readonly errorClass = "infra" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlmInfraError";
  }
}

/** The model hit its output cap. The same prompt gives the same result, so it is not retried. */
export class OutputTruncatedError extends Error {
  readonly errorClass = "item" as const;
  /** Park the item now — retrying cannot help. */
  readonly parkNow = true as const;
  readonly parkReason = "output too long";
  constructor(
    readonly model: string,
    readonly maxTokens: number,
    readonly outputLength: number
  ) {
    super(`output too long: ${model} hit max_tokens (${maxTokens}) after ${outputLength} chars`);
    this.name = "OutputTruncatedError";
  }
}
