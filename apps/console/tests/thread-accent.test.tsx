import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useThreadColor } from "../components/use-thread-color.ts";
import { accentForeground, beginColorChange, resetThreadColorStore, threadAccentStyle } from "../src/core/index.ts";

afterEach(() => resetThreadColorStore());

const Probe = ({ id, color }: { id: string; color?: string }) => createElement("i", { style: threadAccentStyle(useThreadColor({ id, ...(color ? { color } : {}) }).hex) });
const html = (id: string, color?: string) => renderToStaticMarkup(createElement(Probe, { id, ...(color ? { color } : {}) }));

describe("thread accent variable", () => {
	it("falls back to teal when there is no thread colour", () => {
		assert.deepEqual(threadAccentStyle(undefined), { "--thread-accent": "var(--primary)", "--thread-accent-foreground": "var(--primary-foreground)" });
	});
	it("follows the thread's colour, and a live pick, with a readable foreground", () => {
		assert.match(html("w/a", "red"), new RegExp(`--thread-accent:#f07178`));
		beginColorChange("w/a", "blue", "red");
		assert.match(html("w/a", "red"), new RegExp(`--thread-accent:#6cb2f2`));
		for (const hex of ["#f07178", "#f5a15a", "#e6cd69", "#8bd17c", "#a3e635", "#6cb2f2", "#b69cf5", "#f28cc4"]) assert.equal(accentForeground(hex), "#0f141a");
		assert.equal(accentForeground("#101820"), "#ffffff");
	});
});
