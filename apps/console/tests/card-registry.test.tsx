/**
 * Card registry dispatch: a known tool resolves to its registered
 * renderer, an unknown tool to nothing (chat.tsx then falls back exactly
 * as before — the live card while streaming, else no card), and the
 * "tool" / "object" namespaces never shadow each other.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { lookupCard, registerCard, resolveToolPart, unregisterCard } from "../components/card-registry.tsx";
import { ToolCallCard } from "../components/artifacts/tool-call-card.tsx";

describe("card registry", () => {
	it("known tools resolve to their registered renderer", () => {
		for (const name of ["read", "ls", "find", "grep"]) {
			assert.equal(lookupCard("tool", name)?.Renderer, ToolCallCard, name);
		}
		for (const name of ["quiz", "ask_user_question", "explain"]) {
			assert.equal(lookupCard("tool", name)?.ownsStreaming, true, name);
		}
	});

	it("unknown tools resolve to nothing (the caller's fallback)", () => {
		assert.equal(lookupCard("tool", "no_such_tool"), undefined);
	});

	it("question cards stay empty until answered", () => {
		const Card = lookupCard("tool", "quiz")!.Renderer;
		const part = { type: "tool-quiz", toolCallId: "c1", input: {} };
		assert.equal(renderToStaticMarkup(<Card part={{ ...part, state: "input-available" }} />), "");
		assert.equal(renderToStaticMarkup(<Card part={{ ...part, state: "input-streaming" }} />), "");
	});

	it("only the filesystem set expands into thread rows", () => {
		for (const name of ["read", "ls", "find", "grep"]) assert.equal(lookupCard("tool", name)?.threadRow, true, name);
		for (const name of ["quiz", "ask_user_question", "explain"]) assert.notEqual(lookupCard("tool", name)?.threadRow, true, name);
	});

	it("re-registering the same renderer is a no-op; a different one throws", () => {
		registerCard("tool", "read", { Renderer: ToolCallCard });
		assert.equal(lookupCard("tool", "read")?.threadRow, true);
		assert.throws(() => registerCard("tool", "read", { Renderer: () => null }), /already registered/);
	});

	it("kinds are separate namespaces", () => {
		const Renderer = () => null;
		registerCard("object", "read", { Renderer });
		try {
			assert.equal(lookupCard("object", "read")?.Renderer, Renderer);
			assert.equal(lookupCard("tool", "read")?.Renderer, ToolCallCard);
		} finally {
			unregisterCard("object", "read");
		}
		assert.equal(lookupCard("object", "read"), undefined);
	});

	describe("resolveToolPart (chat.tsx dispatch)", () => {
		const p = (tool: string, state: string) => ({ type: `tool-${tool}`, toolCallId: "c", state, input: {}, output: {} });
		it("ownsStreaming suppresses the live card", () => {
			assert.equal(resolveToolPart(p("quiz", "input-streaming")).kind, "card");
		});
		it("unknown tool: live while streaming, else nothing", () => {
			assert.equal(resolveToolPart(p("zzz", "input-streaming")).kind, "live");
			assert.equal(resolveToolPart(p("zzz", "output-available")).kind, "none");
		});
		it("read: live while streaming, then ToolCallCard", () => {
			assert.equal(resolveToolPart(p("read", "input-streaming")).kind, "live");
			const r = resolveToolPart(p("read", "output-available"));
			assert.ok(r.kind === "card" && r.Renderer === ToolCallCard);
		});
		it("question tools: nothing on output-error", () => {
			const r = resolveToolPart(p("quiz", "output-error"));
			assert.ok(r.kind === "card");
			assert.equal(renderToStaticMarkup(<r.Renderer part={p("quiz", "output-error")} />), "");
		});
		it("non-tool parts resolve to nothing", () => {
			assert.equal(resolveToolPart({ type: "text", toolCallId: "c", state: "x" }).kind, "none");
		});
	});
});
