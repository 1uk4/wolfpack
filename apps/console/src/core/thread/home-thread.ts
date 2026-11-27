/**
 * The thread the floating chat attaches on its own when nothing is attached: the owner's own wolf's home thread. PURE.
 * "The owner's own wolf" is pickOwnerWolf (the first online non-librarian wolf); remote wolves, feature threads, sub-agent
 * threads and closed threads are never picked, so the bar never lands somewhere that has no composer.
 */
import { attachable, pickOwnerWolf, type AttachedRef, type ThreadsByWolf, type WolfLite } from "./chat-bar.ts";
import { threadSlug } from "./thread-adapter.ts";

export function pickHomeThread(wolves: readonly WolfLite[], threads: ThreadsByWolf): AttachedRef | null {
	const wolf = pickOwnerWolf(wolves);
	if (!wolf) return null;
	const home = threads[wolf]?.find((t) => t.kind === "home" && attachable(t));
	return home ? { wolf, threadId: home.id, slug: threadSlug(wolf, home.id) } : null;
}
