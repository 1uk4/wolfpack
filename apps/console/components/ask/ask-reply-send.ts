import { cardTextUrl } from "@/components/thread/thread-transport";

/**
 * Reply mode: POST a question's typed answer (text and/or bound image ids) to the card. Resolves to null when saved, else the
 * error to show. Both composers use it; each takes the text and ready images out of its composer BEFORE calling (so a second
 * Send finds nothing to send) and puts them back on an error.
 */
export async function postReply(wolf: string, slug: string, callId: string, qid: string, text: string, imageIds: string[], multi?: { picked: string[]; others: string[] }): Promise<string | null> {
	try {
		// A multi question sends its whole picked/custom list (it replaces the draft); `text` is not used then.
		const body = multi ? { picked: multi.picked, others: multi.others, ...(imageIds.length ? { attachments: imageIds } : {}) } : { text, ...(imageIds.length ? { attachments: imageIds } : {}) };
		const res = await fetch(cardTextUrl(wolf, slug, callId, qid), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
		if (res.ok) return null;
		const b = (await res.json().catch(() => null)) as { error?: string } | null;
		return b?.error ?? "Could not save the answer.";
	} catch {
		return "Could not save the answer.";
	}
}
