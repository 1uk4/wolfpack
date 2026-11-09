import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useThreadColor } from "../components/use-thread-color.ts";
import { accentForeground, threadAccentStyle } from "../src/core/index.ts";

const Probe = ({ id, wolfColor }: { id: string; wolfColor?: string }) => createElement("i", { style: threadAccentStyle(useThreadColor({ id, kind: "home" }, [], wolfColor).hex) });
const html = (id: string, wolfColor?: string) => renderToStaticMarkup(createElement(Probe, { id, ...(wolfColor ? { wolfColor } : {}) }));

describe("thread accent variable", () => {
	it("falls back to teal when there is no thread colour", () => {
		assert.deepEqual(threadAccentStyle(undefined), { "--thread-accent": "var(--primary)", "--thread-accent-foreground": "var(--primary-foreground)" });
	});
	it("follows the wolf's colour on its home thread, with a readable foreground", () => {
		assert.match(html("w/home", "red"), new RegExp(`--thread-accent:#f07178`));
		for (const hex of ["#f07178", "#f5a15a", "#e6cd69", "#8bd17c", "#a3e635", "#6cb2f2", "#b69cf5", "#f28cc4"]) assert.equal(accentForeground(hex), "#0f141a");
		assert.equal(accentForeground("#101820"), "#ffffff");
	});
});
