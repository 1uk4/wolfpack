/**
 * Card registry dispatch: a known tool resolves to its registered
 * renderer, an unknown tool to nothing (chat.tsx then falls back exactly
 * as before — the live card while streaming, else no card), and the
 * "tool" / "object" namespaces never shadow each other.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { lookupCard, registerCard } from "../components/card-registry.tsx";
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

	it("kinds are separate namespaces", () => {
		const Renderer = () => null;
		registerCard("object", "read", { Renderer });
		assert.equal(lookupCard("object", "read")?.Renderer, Renderer);
		assert.equal(lookupCard("tool", "read")?.Renderer, ToolCallCard);
	});
});
