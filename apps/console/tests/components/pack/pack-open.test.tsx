/**
 * Seam: opening the Pack page (components/pack/pack-nav.ts openPackPage, readPackReturn), work-wolfpack-oz3wvq3.
 * Covers: the opener navigates to /pack/<section> and remembers where you were; the return path accepts only same-origin paths. (The ?pack= redirect is proxy.ts: tests/proxy.test.ts.)
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
const session = new Map<string, string>();
const loc = { search: "", pathname: "/work", origin: "http://localhost:3210" };
Object.assign(dom.window, {
	location: loc,
	sessionStorage: { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => void session.set(k, v), removeItem: (k: string) => void session.delete(k) },
});
Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });

const { openPackPage, setPackNavigator, readPackReturn } = await import("../../../components/pack/pack-nav.ts");

afterEach(async () => {
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

	it("readPackReturn keeps a same-origin path and sends anything else (protocol-relative, backslash, scheme, other origin) to /", () => {
		for (const bad of ["//evil.com", "/\\evil.com", "javascript:x", "https://evil.com"]) {
			session.set("wp.pack.return", bad);
			assert.equal(readPackReturn(), "/", bad);
		}
		session.set("wp.pack.return", "/work?x=1");
		assert.equal(readPackReturn(), "/work?x=1");
	});
});
