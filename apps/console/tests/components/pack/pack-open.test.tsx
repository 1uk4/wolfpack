/**
 * Seam: opening the Pack page (components/pack/pack-nav.ts openPackPage, PackHealthHost's ?pack= redirect), work-wolfpack-oz3wvq3.
 * Covers: the opener navigates to /pack/<section> and remembers where you were; ?pack=<section> on any page redirects, keeping wolf params.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
const session = new Map<string, string>();
const loc = { search: "", pathname: "/work" };
Object.assign(dom.window, {
	location: loc,
	sessionStorage: { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => void session.set(k, v), removeItem: (k: string) => void session.delete(k) },
});
Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });

const { openPackPage, setPackNavigator } = await import("../../../components/pack/pack-nav.ts");
const { PackHealthHost } = await import("../../../components/pack/pack-health.tsx");
const { FakeNav, currentUrl } = await import("../../helpers/fake-nav.tsx");

let root: Root | null = null;
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	session.clear();
	setPackNavigator(null);
});

describe("opening the Pack page", () => {
	it("openPackPage goes to /pack/<section> (machines by default) and remembers the page it left", () => {
		const went: string[] = [];
		setPackNavigator((h) => void went.push(h));
		loc.pathname = "/work";
		loc.search = "?q=a";
		openPackPage("keys");
		openPackPage();
		assert.deepEqual(went, ["/pack/keys", "/pack/machines"]);
		assert.equal(session.get("wp.pack.return"), "/work?q=a");
	});

	it("keeps the page you first left when you open the Pack from inside it", () => {
		setPackNavigator(() => {});
		loc.pathname = "/work";
		loc.search = "";
		openPackPage("keys");
		loc.pathname = "/pack/keys";
		openPackPage("wolves");
		assert.equal(session.get("wp.pack.return"), "/work");
	});

	const visit = async (path: string, search: string) => {
		loc.pathname = path;
		loc.search = search;
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () =>
			root!.render(
				<FakeNav start={path + search}>
					<PackHealthHost />
				</FakeNav>,
			),
		);
	};

	it("?pack=keys on any page redirects to /pack/keys and remembers that page without the query", async () => {
		await visit("/work", "?pack=keys");
		assert.equal(currentUrl(), "/pack/keys");
		assert.equal(session.get("wp.pack.return"), "/work");
	});

	it("?pack=wolves keeps wolf, wolfTab and view, and an unknown section goes to machines", async () => {
		await visit("/", "?pack=wolves&wolf=mac%2Fhal&wolfTab=prompts&view=prompt:system.identity");
		assert.equal(currentUrl(), "/pack/wolves?wolf=mac%2Fhal&wolfTab=prompts&view=prompt%3Asystem.identity");
		await act(async () => root?.unmount());
		document.body.innerHTML = "";
		await visit("/", "?pack=nope");
		assert.equal(currentUrl(), "/pack/machines");
	});
});
