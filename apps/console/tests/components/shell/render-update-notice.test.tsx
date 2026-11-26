/**
 * Seam: the sidebar update notice (UpdateNoticeView, components/shell/update-notice.tsx) rendered to static markup from /api/updates rows
 * (work-wolfpack-vkAgw7I). Covers the plain wording per machine, the failed line, no raw state or repo path, no stale/manual text,
 * the Update now link target, and that a dismissed version stays hidden until a newer one appears.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UpdateNoticeView } from "../../../components/shell/update-notice.tsx";

const row = (component: string, latest: string, host = "sfo-01", status: Record<string, unknown> = { state: "idle" }) => ({
	component,
	running: "0.1.22",
	latest,
	outdated: true,
	notesUrl: `https://example.test/notes/${component}`,
	updateStep: "Deploy the hubd release to sfo-01 (deploy/hubd/RUNBOOK.md).",
	updateStatus: { host, lastCheck: "2026-11-25T10:00:00Z", ...status } as unknown as { state: string; host?: string },
});
const html = (rows: ReturnType<typeof row>[], dismissed: string[] = []) =>
	renderToStaticMarkup(<UpdateNoticeView rows={rows} dismissed={new Set(dismissed)} onDismiss={() => {}} />);
const text = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").replaceAll("&#x27;", "'");

describe("sidebar update notice", () => {
	it("says which machine has which update, in plain words", () => {
		const t = text(html([row("hubd", "0.1.23")]));
		assert.match(t, /sfo-01: hubd 0\.1\.23 is available/);
		assert.match(t, /Update now/);
		assert.match(t, /What's new/);
	});

	it("groups several updates on one machine and lists their names", () => {
		const t = text(html([row("hubd", "0.1.23"), row("workerd", "0.1.11")]));
		assert.match(t, /sfo-01: 2 updates available/);
		assert.match(t, /hubd 0\.1\.23/);
		assert.match(t, /workerd 0\.1\.11/);
	});

	it("reads a failed update as plain text and shows no raw state, code or repo path", () => {
		const h = html([row("hubd", "0.1.23", "sfo-01", { state: "failed", code: "unhealthy" }), row("console", "0.1.30", "sfo-01", { state: "updated", stale: true, manual: true })]);
		const t = text(h);
		assert.match(t, /Update failed on sfo-01/);
		assert.doesNotMatch(t, /\[|\]|unhealthy|failed:|RUNBOOK|deploy\/|updates itself|Manual updates|hasn't run/);
	});

	it("points Update now at the Pack machines page with machine and components", () => {
		const h = html([row("hubd", "0.1.23"), row("workerd", "0.1.11")]);
		assert.match(h, /href="\/pack\/machines\?update=sfo-01%3Ahubd%2Cworkerd"/);
	});

	it("shows the Mac app's own stage with the approved label, the percent and the plain error, and nothing when idle", () => {
		const app = (state: string, extra: Record<string, unknown> = {}) => ({ target: "app", host: "this Mac", state, current: "0.2.0", latest: "0.2.1", progress: null, lastCheck: null, channel: "stable", auto: "on", ...extra }) as never;
		const view = (a: unknown) => text(renderToStaticMarkup(<UpdateNoticeView rows={[]} app={a as never} dismissed={new Set()} onDismiss={() => {}} onInstall={() => {}} />));
		assert.match(view(app("downloading", { progress: 42 })), /Downloading 42%/);
		assert.match(view(app("ready", { progress: 100 })), /Ready, restart to update/);
		assert.match(view(app("ready", { progress: 100 })), /Update now/);
		assert.match(view(app("installing")), /Installing…/);
		const failed = view(app("failed", { error: { code: "offline", message: "Couldn't reach the update server.", retryable: true } }));
		assert.match(failed, /Update failed Couldn't reach the update server\./);
		for (const s of ["idle", "updated", "available"]) assert.equal(view(app(s)), "");
	});

	it("shows a pack host that is installing with the installing label", () => {
		const r = { ...row("hubd", "0.1.23"), updateState: { state: "installing", progress: null } };
		assert.match(text(html([r as never])), /sfo-01: Installing…/);
	});

	it("stays hidden for a dismissed version and returns for a newer one", () => {
		assert.equal(html([row("hubd", "0.1.23")], ["hubd@0.1.23"]), "");
		assert.match(text(html([row("hubd", "0.1.24")], ["hubd@0.1.23"])), /hubd 0\.1\.24 is available/);
	});
});
