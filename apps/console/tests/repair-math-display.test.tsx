/** Display repair is shared, not a mutation of saved arguments. */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { QuestionDock } from "../components/question-dock.tsx";
import { LatexGlyph } from "../components/latex-glyph.tsx";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import {
	repairMathForDisplay, healOverescapedCommands, restoreMathEscapes,
	parseQuizInput, parseAskInput, parseExplainInput,
} from "../src/core/index.ts";

const tex = String.raw`\nabla f(x) \in \mathbb{R}^{m \times n}`;
const clean = `$${tex}$`;
const doubled = clean.replace(/\\/g, "\\\\");
const quadrupled = clean.replace(/\\/g, "\\\\\\\\");
const debris = "$\forall x \\in \\mathbb{R}$"; // JSON's form feed consumed the f.
const repairedDebris = String.raw`\forall x \in \mathbb{R}`;
const matrix = "$$\n" + String.raw`\\begin{pmatrix}1 & 2 \\ 3 & 4\\end{pmatrix}` + "\n$$";
const repairedMatrix = String.raw`\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}`;
function math(html: string) {
	const { document } = parseHTML(html);
	return {
		annotations: [...document.querySelectorAll('annotation[encoding="application/x-tex"]')].map((n) => n.textContent),
		glyphs: [...document.querySelectorAll(".katex-html")].map((n) => n.textContent).join(""),
		errors: document.querySelectorAll(".katex-error").length,
	};
}
function assertMath(html: string, expected = [tex], glyphs = ["∇", "∈", "×"]) {
	const actual = math(html);
	assert.deepEqual(actual.annotations, expected, "exact TeX, not merely absence of errors");
	assert.equal(actual.errors, 0);
	for (const glyph of glyphs) assert.ok(actual.glyphs.includes(glyph), `rendered glyph ${glyph}`);
}

describe("repairMathForDisplay — the existing composition, unchanged", () => {
	const unchanged = [
		clean,
		String.raw`outside \\nabla`,
		String.raw`$a \\\nabla b$`,
		String.raw`$a \\\\\nabla b$`,
		String.raw`$a \\ 2 \\& 3 \\[6pt] 4$`,
		"$$\na \\\\\\\\ 2\nb\n$$", // four real row-break slashes survive too.
		"`" + doubled + "`",
		"```tex\n" + doubled + "\n```",
		"`" + debris + "`",
		"```tex\n" + debris + "\n```",
		String.raw`$\\nabla`,
		"$$A = \\\\begin{pmatrix}\n1 & 2\n\\\\end{pmatrix}$$", // unsupported midline display close.
	];
	for (const [index, value] of [...unchanged, doubled, quadrupled, debris, matrix,
		String.raw`\(\\nabla\)`, "\\[\n\\\\nabla\n\\]"].entries()) {
		it(`matches the old composition byte-for-byte (${index})`, () => {
			assert.equal(repairMathForDisplay(value), healOverescapedCommands(restoreMathEscapes(value)));
		});
	}
	it("preserves clean math, odd runs, row breaks, code, prose and existing recognition limits", () => {
		for (const value of unchanged) assert.equal(repairMathForDisplay(value), value);
		assert.equal(repairMathForDisplay(doubled), clean);
		assert.equal(repairMathForDisplay(quadrupled), clean);
		assert.equal(repairMathForDisplay(debris), `$${repairedDebris}$`);
		assert.equal(repairMathForDisplay(matrix), `$$\n${repairedMatrix}\n$$`);
	});
});

describe("upgraded KaTeX rendering on real question surfaces", () => {
	for (const [name, formula, glyphs] of [
		["fraction and root", String.raw`\frac{1}{\sqrt{x}}`, ["1", "x"]],
		["accents", String.raw`\hat{x}+\bar{y}`, ["x", "y"]],
		["sum", String.raw`\sum_{i=1}^{n}i`, ["∑", "i", "n"]],
		["matrix rows", String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`, ["1", "2", "3", "4"]],
		["aligned rows", String.raw`\begin{aligned}a&=b\\ c&=d\end{aligned}`, ["a", "b", "c", "d", "="]],
	] as const) {
		it(`${name}: dollar and legacy delimiters preserve glyphs and copied TeX`, () => {
			for (const raw of [`$${formula}$`, `\\(${formula}\\)`, `$$\n${formula}\n$$`, `\\[\n${formula}\n\\]`]) {
				for (const element of [
					<MessageResponse mode="static">{raw}</MessageResponse>,
					<QuestionDock toolName="ask_user_question" toolCallId="security_question" input={{ question: raw }} expanded onExpand={() => {}} onSubmit={() => {}} />,
				]) {
					const html = renderToStaticMarkup(element);
					assertMath(html, [formula], [...glyphs]);
					const { document } = parseHTML(html);
					assert.ok(document.querySelector(".katex-base .katex-strut"), "matching 0.18 internal layout classes");
					if (name === "fraction and root") assert.ok(document.querySelector(".mfrac .sqrt"));
					if (name === "accents") assert.ok(document.querySelectorAll(".katex-accent").length >= 2);
					if (name.endsWith("rows")) assert.ok(document.querySelectorAll(".mtable .mtr").length >= 2 || document.querySelectorAll(".mtable .vlist > span").length >= 2, "two real rows, not repaired-away slashes");
				}
			}
		});
	}
	it("preserves escaped currency and code on the question dock", () => {
		const raw = "Costs \\$5 and \\$10. `" + clean + "`\n\n```text\n" + doubled + "\n```";
		for (const element of [<QuestionDock toolName="ask_user_question" toolCallId="security_code" input={{ question: raw }} expanded onExpand={() => {}} onSubmit={() => {}} />]) {
			const html = renderToStaticMarkup(element);
			assert.deepEqual(math(html).annotations, []);
			assert.ok(parseHTML(html).document.firstElementChild?.textContent?.includes("$5 and $10"));
			assert.ok(parseHTML(html).document.querySelector("code")?.textContent?.includes(clean));
		}
	});
	it("renders direct LatexGlyph connectors through the upgraded root", () => {
		for (const [command, glyph] of [[String.raw`\Rightarrow`, "⇒"], [String.raw`\land`, "∧"], [String.raw`\neg`, "¬"]]) {
			const html = renderToStaticMarkup(<LatexGlyph cmd={command!} />);
			const { document } = parseHTML(html);
			assert.equal(document.querySelectorAll(".katex-error").length, 0);
			assert.ok(document.querySelector(".katex-base .katex-strut"));
			assert.ok(document.querySelector(".katex-html")?.textContent?.includes(glyph!));
		}
	});
});
