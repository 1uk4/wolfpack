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
		assert.match(t, /sfo-01: Update failed(?!:)/);
		assert.doesNotMatch(t, /\[|\]|unhealthy|failed:|RUNBOOK|deploy\/|updates itself|Manual updates|hasn't run/);
	});

	it("a failed pack update reads Update failed: <plain reason> with Retry (not Update now), disabled while a retry is pending", () => {
		const failed = { ...row("hubd", "0.1.23", "sfo-01", { state: "failed", code: "unhealthy" }), updateState: { state: "failed", progress: null, error: { code: "unhealthy", message: "The update installed but the service did not start healthy, so it was left as it is.", retryable: false } } };
		const view = (retrying: boolean) => renderToStaticMarkup(<UpdateNoticeView rows={[failed as never]} dismissed={new Set()} onDismiss={() => {}} onRetry={() => {}} retrying={retrying} />);
		const t = text(view(false));
		assert.match(t, /sfo-01: Update failed: The update installed but the service did not start healthy, so it was left as it is\./);
		assert.match(t, /Retry/);
		assert.doesNotMatch(t, /Update now|--clear-failed|ssh|RUNBOOK|runtime:update|deploy\//i);
		assert.match(view(true), /<button[^>]*disabled=""[^>]*>Retry/);
	});

	it("a failed Mac app update offers Retry", () => {
		const app = { target: "app", host: "this Mac", state: "failed", current: "0.2.0", latest: null, progress: null, lastCheck: null, channel: "stable", auto: "on", error: { code: "offline", message: "Couldn't reach the update server.", retryable: true } };
		const t = text(renderToStaticMarkup(<UpdateNoticeView rows={[]} app={app as never} dismissed={new Set()} onDismiss={() => {}} onRetryApp={() => {}} />));
		assert.match(t, /Update failed: Couldn't reach the update server\. Retry/);
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
		assert.match(failed, /Update failed: Couldn't reach the update server\./);
		for (const s of ["idle", "updated", "available"]) assert.equal(view(app(s)), "");
	});

	it("heads the Mac app's row with This app when the window shows a remote console", () => {
		const app = { target: "app", host: "this Mac", state: "ready", current: "0.2.0", latest: "0.2.1", progress: 100, lastCheck: null, channel: "stable", auto: "on" };
		const view = (appHeading?: string) => text(renderToStaticMarkup(<UpdateNoticeView rows={[]} app={app as never} appHeading={appHeading} dismissed={new Set()} onDismiss={() => {}} onInstall={() => {}} />));
		assert.match(view("This app"), /This app: Ready, restart to update.*Update now/);
		assert.doesNotMatch(view(), /This app/);
	});

	it("hides a quiet (background) Mac app failure in the sidebar but keeps a user-pressed one", () => {
		const failed = (quiet: boolean) => ({ target: "app", host: "this Mac", state: "failed", current: "0.2.0", latest: null, progress: null, lastCheck: null, channel: "stable", auto: "on", error: { code: "offline", message: "Couldn't reach the update server.", retryable: true, ...(quiet ? { quiet: true } : {}) } }) as never;
		const view = (a: unknown) => text(renderToStaticMarkup(<UpdateNoticeView rows={[]} app={a as never} dismissed={new Set()} onDismiss={() => {}} onRetryApp={() => {}} />));
		assert.equal(view(failed(true)), "");
		assert.match(view(failed(false)), /Update failed/);
	});

	it("shows why a Retry on the pack failed, in the card", () => {
		const failed = { ...row("hubd", "0.1.23", "sfo-01", { state: "failed", code: "unhealthy" }), updateState: { state: "failed", progress: null, error: { code: "unhealthy", message: "It did not start.", retryable: false } } };
		const t = text(renderToStaticMarkup(<UpdateNoticeView rows={[failed as never]} dismissed={new Set()} onDismiss={() => {}} onRetry={() => {}} retryError="Update failed: This machine needs its update service reinstalled." />));
		assert.match(t, /This machine needs its update service reinstalled\./);
	});

	it("shows a pack host that is installing with the installing label", () => {
		const r = { ...row("hubd", "0.1.23"), updateState: { state: "installing", progress: null } };
		assert.match(text(html([r as never])), /sfo-01: Installing…/);
	});

	it("What's new is a button that opens that row's release notes, and falls back to the release link when there are none", () => {
		const r = row("hubd", "0.1.23");
		const view = (notes?: { machine: string; state: "loading" | "missing" | { body: string; url: string } }) =>
			renderToStaticMarkup(<UpdateNoticeView rows={[r]} dismissed={new Set()} onDismiss={() => {}} onOpenNotes={() => {}} notes={notes} />);
		assert.match(view(), /<button[^>]*>What(&#x27;|')s new<\/button>/);
		assert.doesNotMatch(view(), /role="dialog"/);
		assert.match(text(view({ machine: "sfo-01", state: "loading" })), /Loading release notes/);
		const open = view({ machine: "sfo-01", state: { body: "## Fixes\n\n- Update now works from any console", url: "https://github.com/1uk4/wolfpack/releases/tag/hubd%2Fv0.1.23" } });
		assert.match(open, /role="dialog"/);
		assert.match(text(open), /Fixes Update now works from any console/);
		assert.match(open, /href="https:\/\/github\.com\/1uk4\/wolfpack\/releases\/tag\/hubd%2Fv0\.1\.23"[^>]*>View on GitHub/);
		const missing = view({ machine: "sfo-01", state: "missing" });
		assert.match(missing, /href="https:\/\/example\.test\/notes\/hubd"[^>]*>View on GitHub/);
	});

	it("also lists wolves behind on this machine from the hub inventory, one line per component, never another machine's and never workerd twice", () => {
		const inv = (machine: string, kind: string, id: string, version: string, latest: string | null) => ({ machine, kind, id, version, latest, ageS: 1 });
		const ownInventory = {
			self: "lukas-macbook-pro",
			rows: [
				inv("lukas-macbook-pro", "wolfd", "1uk4", "0.1.24-main.3", "0.1.24-main.4"),
				inv("lukas-macbook-pro", "wolfd", "jack", "0.1.24-main.3", "0.1.24-main.4"),
				inv("lukas-macbook-pro", "workerd", "mac-1uk4", "0.1.10", "0.1.11"),
				inv("lukas-macbook-pro", "hubd", "hubd", "0.1.1", null),
				inv("sfo-01", "wolfd", "hal", "0.1.1", "0.1.2"),
			],
		} as never;
		const view = (rows: ReturnType<typeof row>[]) => text(renderToStaticMarkup(<UpdateNoticeView rows={rows} ownInventory={ownInventory} dismissed={new Set()} onDismiss={() => {}} />));
		const t = view([]);
		assert.match(t, /lukas-macbook-pro: 2 updates available/);
		assert.match(t, /wolfd 0\.1\.24-main\.4, workerd 0\.1\.11/);
		assert.doesNotMatch(t, /sfo-01/);
		// /api/updates already lists this machine's workerd: its line is not repeated, and the wolves join the same machine's card.
		const t2 = view([row("workerd", "0.1.11", "lukas-macbook-pro")]);
		assert.equal(t2.match(/workerd 0\.1\.11/g)?.length, 1);
		assert.match(t2, /lukas-macbook-pro: 2 updates available/);
	});

	it("names this machine like its card (selfLabel) and does not list workerd twice when /api/updates rows carry no host", () => {
		const inv = (kind: string, id: string, version: string, latest: string) => ({ machine: "lukas-macbook-pro", kind, id, version, latest, ageS: 1 });
		const ownInventory = { self: "lukas-macbook-pro", selfLabel: "Mac", rows: [inv("wolfd", "1uk4", "0.1.24-main.3", "0.1.24-main.4"), inv("workerd", "mac-1uk4", "0.1.10", "0.1.11")] } as never;
		const hostless = { component: "workerd", running: "0.1.10", latest: "0.1.11", outdated: true, notesUrl: null };
		const h = renderToStaticMarkup(<UpdateNoticeView rows={[hostless]} ownInventory={ownInventory} dismissed={new Set()} onDismiss={() => {}} />);
		const t = text(h);
		assert.match(t, /Mac: 2 updates available/);
		assert.doesNotMatch(t, /lukas-macbook-pro/);
		assert.equal(t.match(/workerd 0\.1\.11/g)?.length, 1);
	});

	it("stays hidden for a dismissed version and returns for a newer one", () => {
		assert.equal(html([row("hubd", "0.1.23")], ["hubd@0.1.23"]), "");
		assert.match(text(html([row("hubd", "0.1.24")], ["hubd@0.1.23"])), /hubd 0\.1\.24 is available/);
	});
});
