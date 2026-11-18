import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CuratorStuckWarning } from "../../../components/pack/pack-health.tsx";

describe("CuratorStuckWarning (pack health)", () => {
	it("says the hub curator is stuck, since when, and that new sweeps are skipped", () => {
		const html = renderToStaticMarkup(<CuratorStuckWarning stuckSince="2026-11-05T09:45:00.000Z" now={Date.parse("2026-11-05T10:00:00Z")} />);
		assert.match(html, /data-testid="pack-curator-stuck"/);
		assert.match(html, /Hub curator stuck since 15m ago/);
		assert.match(html, /new sweeps are skipped until it does/);
	});
});
