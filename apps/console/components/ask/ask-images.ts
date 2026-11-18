import type { CardFieldAnswer } from "@wolfpack/client";

/** Image ids bound to a question's draft answer (reply mode); the protocol's answer union does not type them. */
export const imagesOf = (a: CardFieldAnswer | undefined): string[] => (a as { attachments?: string[] } | undefined)?.attachments ?? [];

/** The answer with its bound images set (an empty list removes them). */
export function withImages(a: CardFieldAnswer, ids: string[]): CardFieldAnswer {
	const { attachments: _drop, ...rest } = a as { attachments?: string[] };
	return (ids.length ? { ...rest, attachments: ids } : rest) as unknown as CardFieldAnswer;
}
