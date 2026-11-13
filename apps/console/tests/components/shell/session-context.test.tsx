import React from "react";
(globalThis as Record<string, unknown>).React = React;

import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionRow } from "../../../components/shell/sidebar.tsx";
import type { ChatListItem } from "../../../src/core/index.ts";

/**
 * Wave 6 chunk A — the deletion + context-menu seams on the sidebar:
 * SessionRow's right-click seam (always carries the row testid now), the
 * inline RenameRow (same geometry, select-all entry), and the delete
 * dialog's shape.
 */

const chat: ChatListItem & { href: string } = {
	id: "c1",
	href: "/t/c1",
	title: "Wave mechanics",
	updatedAt: new Date().toISOString(),
	busy: false,
} as unknown as ChatListItem & { href: string };

describe("SessionRow — the right-click seam", () => {
	it("rows carry the session-row testid (context menu anchors to it)", () => {
		const html = renderToStaticMarkup(<SessionRow chat={chat} active={false} onOpen={() => {}} />);
		assert.ok(html.includes('data-testid="session-row"'));
	});
});
