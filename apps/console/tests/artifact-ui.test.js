/**
 * THE ARTIFACT-UI ROUTE (owner, 2026-10-07): POST /api/chats/:id/artifact-ui
 * persists the learner's invert switch onto a demo/figure steer message
 * (details.ui.inverted) — the silent record-write route (no wake, no SSE).
 * The pure core (setSteerUiInverted) is pinned in tests/demos.test.tsx;
 * this file pins the ROUTE contract: 404 unknown chat, 400 for a bad body
 * or a non-artifact message id, and the record actually carrying the flag
 * after a write.
 *
 * Runs under an isolated LH_DATA_DIR (the chat-birth-stamp discipline:
 * the seam is set before any config-loading import, so every app-module
 * import is dynamic).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-artifact-ui-"));
process.env.LH_DATA_DIR = TMP_DATA;
let POST;
let createChat;
let saveMessages;
let getChat;
let buildSubagentSteerFn;
before(async () => {
    const route = await import("../app/api/chats/[id]/artifact-ui/route.ts");
    POST = route.POST;
    const server = await import("../src/server/chats.ts");
    createChat = server.createChat;
    getChat = server.getChat;
    const { chatStore } = await import("../src/store/chats.ts");
    saveMessages = (id, messages) => chatStore.saveMessages(id, messages);
    const contracts = await import("../src/core/contracts.ts");
    buildSubagentSteerFn = contracts.buildSubagentSteer;
});
const post = (id, body) => POST(new Request("http://x/api", { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
});
describe("POST /api/chats/:id/artifact-ui", () => {
    it("404s an unknown chat", async () => {
        const res = await post("nope", { input: { messageId: "x", inverted: true } });
        assert.equal(res.status, 404);
    });
    it("400s a malformed body and a non-artifact message id", async () => {
        const chat = createChat("Artifact UI guards");
        const steer = buildSubagentSteerFn({ id: "jg", kind: "demo", toolCallId: "cg" }, { title: "T", html: "<p>x</p>", tested: true });
        saveMessages(chat.id, [
            { id: "m1", role: "user", content: "hi" },
            steer,
        ]);
        assert.equal((await post(chat.id, { input: { messageId: "m1", inverted: true } })).status, 400);
        assert.equal((await post(chat.id, { input: { messageId: "missing", inverted: true } })).status, 400);
        assert.equal((await post(chat.id, {})).status, 400);
        assert.equal((await post(chat.id, { input: { messageId: "m1", inverted: "yes" } })).status, 400);
    });
    it("persists ui.inverted onto the demo steer and toggles it back", async () => {
        const chat = createChat("Artifact UI round trip");
        const steer = buildSubagentSteerFn({ id: "jk", kind: "visual", toolCallId: "ck" }, { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>' });
        saveMessages(chat.id, [steer]);
        assert.equal((await post(chat.id, { input: { messageId: steer.id, inverted: true } })).status, 200);
        let saved = getChat(chat.id).messages;
        assert.equal(saved[0].details.ui?.inverted, true, "the flag rides the record");
        assert.equal((await post(chat.id, { input: { messageId: steer.id, inverted: false } })).status, 200);
        saved = getChat(chat.id).messages;
        assert.equal(saved[0].details.ui?.inverted, false, "and toggles back off");
    });
});
after(() => {
    fs.rmSync(TMP_DATA, { recursive: true, force: true });
});
//# sourceMappingURL=artifact-ui.test.js.map