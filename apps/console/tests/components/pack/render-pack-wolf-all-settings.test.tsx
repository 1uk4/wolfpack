/**
 * Seams: WolfAllSettings (components/pack/wolf-all-settings.tsx) and WolfDetail (components/pack/pack-wolves.tsx), rendered to static
 * markup. Effects don't run in SSR, so this pins the first paint: which fields the All settings form offers, and when a wolf shows it.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WolfAllSettings, type WolfSettingsView } from "../../../components/pack/wolf-all-settings.tsx";
import { WolfDetail } from "../../../components/pack/pack-wolves.tsx";

const view: WolfSettingsView = {
	etag: "e1",
	config: { name: "hal", models: { main: { model: "claude-opus-5-5", provider: "anthropic", thinking: "high" } }, memory: { model: "claude-haiku-5-5", enabled: true }, compaction: { threshold: 80 } },
	editable: ["prompts.structuredOutput", "models.main.model", "models.main.provider", "models.main.thinking", "memory.model", "memory.enabled", "compaction.threshold"],
	tierModels: { main: "claude-opus-5-5" },
	env: [{ name: "ANTHROPIC_API_KEY", set: true, secret: true, purpose: "chat" }],
	restartNeeded: true,
	restartable: true,
	restartAvailableInSeconds: 0,
};
const noCall = (async () => new Response("{}")) as typeof fetch;

describe("Pack > Wolves > All settings", () => {
	it("offers every editable setting except the three the Pack's own pickers own", () => {
		const html = renderToStaticMarkup(<WolfAllSettings wolfName="hal" view={view} call={noCall} onView={() => {}} onReload={() => {}} />);
		for (const k of ["models.main.thinking", "memory.enabled", "compaction.threshold"]) assert.match(html, new RegExp(`data-testid="field-${k}"`), k);
		for (const k of ["models.main.model", "models.main.provider", "memory.model"]) assert.ok(!html.includes(`data-testid="field-${k}"`), k);
		assert.ok(!html.includes('data-testid="field-prompts.structuredOutput"'), "structured-output editing is gone");
		assert.match(html, /data-testid="banner-restart-needed"/);
		assert.match(html, /data-testid="restart-button"/);
		assert.match(html, /data-testid="env-ANTHROPIC_API_KEY"/);
	});

	it("shows no All settings section in a wolf this console cannot reach (the reachable case is in render-pack-settings-coverage)", () => {
		const machine = { hostId: "sfo", machine: "sfo-01", online: true, canSetKeys: true, slots: [], wolves: [{ name: "dewey", transport: "api" as const }] };
		const wolf = machine.wolves[0]!;
		const detail = (reach: { relay: boolean; machine: string }) =>
			renderToStaticMarkup(<WolfDetail machine={machine} wolf={wolf} catalog={[]} reach={reach} call={noCall} onBack={() => {}} />);
		const away = detail({ relay: false, machine: "Mac" });
		assert.ok(!away.includes('data-testid="wolf-all-settings"'));
		assert.match(away, /data-testid="wolf-readonly"/);
	});
});

describe("Pack > Wolves > All settings (interaction)", () => {
	type Call = { url: string; init?: RequestInit };
	const mount = async (node: React.ReactElement) => {
		const { parseHTML } = await import("linkedom");
		const dom = parseHTML("<html><body></body></html>");
		Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, IS_REACT_ACT_ENVIRONMENT: true });
		// react-dom/client decides at load time whether `input` events work, so it must load after the DOM globals exist.
		const { createRoot } = await import("react-dom/client");
		const host = dom.document.createElement("div");
		dom.document.body.appendChild(host);
		const root = createRoot(host);
		await act(async () => root.render(node));
		return { dom, root, q: (id: string) => dom.document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null };
	};
	const typeInto = async (_dom: unknown, el: HTMLElement, value: string) => {
		const input = el as HTMLInputElement;
		// linkedom cannot type: call the field's React onChange the way the browser event would.
		await act(async () => {
			input.value = value;
			const key = Object.keys(input).find((k) => k.startsWith("__reactProps$"))!;
			(input as unknown as Record<string, { onChange: (e: unknown) => void }>)[key]!.onChange({ target: input, currentTarget: input });
		});
	};
	const click = (dom: { window: { Event: typeof Event } }, el: HTMLElement) =>
		act(async () => void el.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true })));

	it("Save sends only the changed field with If-Match, never a picker key or structured output", async () => {
		const calls: Call[] = [];
		const call = (async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			return new Response(JSON.stringify({ ...view, etag: "e2" }), { status: 200 });
		}) as unknown as typeof fetch;
		const { dom, root, q } = await mount(<WolfAllSettings wolfName="hal" view={view} call={call} onView={() => {}} onReload={() => {}} />);
		await typeInto(dom, q("field-compaction.threshold")!, "90");
		await click(dom, q("settings-save")!);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.init?.method, "PUT");
		assert.equal((calls[0]!.init?.headers as Record<string, string>)["If-Match"], "e1");
		assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { set: { "compaction.threshold": "90" } });
		await act(async () => root.unmount());
	});

	it("a 400 about a setting the form does not show still appears as a visible form error", async () => {
		const call = (async () => new Response(JSON.stringify({ error: "memory.model: not a model" }), { status: 400 })) as unknown as typeof fetch;
		const { dom, root, q } = await mount(<WolfAllSettings wolfName="hal" view={view} call={call} onView={() => {}} onReload={() => {}} />);
		await typeInto(dom, q("field-compaction.threshold")!, "90");
		await click(dom, q("settings-save")!);
		assert.match(q("settings-form-error")?.textContent ?? "", /memory\.model: not a model/);
		await act(async () => root.unmount());
	});

	it("a wolf whose settings fail to load shows the error in the All settings panel, not Loading", async () => {
		const machine = { hostId: "sfo", machine: "sfo-01", online: true, canSetKeys: true, slots: [], wolves: [{ name: "dewey", transport: "api" as const }] };
		const call = (async () => new Response(JSON.stringify({ error: "wolf is down" }), { status: 502 })) as unknown as typeof fetch;
		const { root, q } = await mount(<WolfDetail machine={machine} wolf={machine.wolves[0]!} catalog={[]} reach={{ relay: false, machine: "sfo-01" }} call={call} onBack={() => {}} />);
		const panel = q("wolf-all-settings")!.textContent ?? "";
		assert.match(panel, /wolf is down/);
		assert.ok(!panel.includes("Loading"));
		await act(async () => root.unmount());
	});
});
