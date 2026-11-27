/** The console's one z-scale: the order is the contract (the chat sits over frames and the viewer, under menus, overlays and modals). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { Z, ZC } = await import("../../../lib/z-layers.ts");

describe("z-layers", () => {
	it("orders content < viewer < chat bar < menus < overlays < modals < popovers", () => {
		const order = [Z.content, Z.viewer, Z.chatBar, Z.menu, Z.overlay, Z.modal, Z.popover];
		assert.deepEqual(order, [...order].sort((a, b) => a - b));
		assert.equal(new Set(order).size, order.length);
	});

	it("keeps the chat's backdrop and sheet between the bar and the menus", () => {
		assert.ok(Z.chatBar < Z.chatBackdrop && Z.chatBackdrop < Z.chatSheet && Z.chatSheet < Z.menu);
	});

	it("spells each class with the number of its layer", () => {
		for (const [name, cls] of Object.entries(ZC)) {
			const base = name.replace(/Phone$/, "");
			assert.ok(cls.endsWith(`z-${(Z as Record<string, number>)[base]}`), `${name}: ${cls}`);
		}
	});
});
