/** Scroll-keeping for "Show earlier": measure before a page loads, restore the delta once its rows are laid out. */
export interface ScrollBox {
	scrollHeight: number;
	scrollTop: number;
}

export function createEarlierScroll() {
	let busy = false;
	let pending: { el: ScrollBox; height: number; top: number } | null = null;
	return {
		/**
		 * Run one load. A trigger while another load is in flight returns at once, before measuring, so it can never
		 * clear or replace the first call's measurement. The measurement is dropped only by the call that made it, and
		 * only when its own load added nothing.
		 */
		async run(el: ScrollBox | null, load: () => Promise<number>): Promise<void> {
			if (busy) return;
			busy = true;
			const mine = el ? { el, height: el.scrollHeight, top: el.scrollTop } : null;
			pending = mine;
			try {
				const added = await load();
				if (!added && pending === mine) pending = null;
			} finally {
				busy = false;
			}
		},
		/** Call from a layout effect once the prepended rows are in the DOM. */
		restore(): void {
			const k = pending;
			if (!k) return;
			pending = null;
			k.el.scrollTop = k.top + (k.el.scrollHeight - k.height);
		},
		get pending(): boolean {
			return pending !== null;
		},
	};
}
