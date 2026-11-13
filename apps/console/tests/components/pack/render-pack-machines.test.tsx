/** Seam: MachineCard (components/pack/pack-machines.tsx), rendered to static markup from card views built by machineCard. */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MachineCard } from "../../../components/pack/pack-machines.tsx";
import { machineCard } from "../../../src/core/pack/machine-card.ts";
import type { HealthLink } from "../../../src/core/pack/pack-health-view.ts";
import type { HostCard } from "../../../src/core/pack/pack-hosts.ts";

const link = (id: string, kind: HealthLink["kind"], over: Partial<HealthLink> = {}): HealthLink => ({
	id, kind, status: "ok", responseMs: 5, lagMs: 1, lastOkAt: null, lastCheckedAt: null, error: null, version: "0.1.20", uptimeS: 60, history: [], lastRestart: null, restartable: true, ...over,
});
const host = (over: Partial<HostCard> = {}): HostCard => ({ id: "sfo-01", label: "sfo-01", hubId: "sfo-01", checked: true, console: false, facts: null, hub: null, workerds: [], wolves: [], inventory: [], ...over });
const html = (c: HostCard, own: "stable" | "main" | null, logs = {}) => renderToStaticMarkup(<MachineCard view={machineCard(c, own)} logs={logs} />);

describe("Pack > Machines card", () => {
	it("an online server shows its services with versions and a read-only channel, and no Restart while all run", () => {
		const out = html(host({ commands: ["wolves.restart", "workerd.restart"], hub: link("hubd", "hubd"), workerds: [{ link: link("workerd", "workerd"), wolves: [link("wolfd@ada", "wolfd")] }], inventory: [{ machine: "sfo-01", kind: "workerd", id: "workerd", version: "0.1.20", channel: "main", ageS: 2, latest: null }] }), null);
		assert.match(out, /data-testid="machine-online"[^>]*>Online/);
		for (const s of ["hubd", "wolfd", "workerd"]) assert.match(out, new RegExp(`data-service="${s}"`));
		assert.match(out, /v0\.1\.20/);
		assert.ok(!out.includes('data-testid="machine-restart"'));
		assert.match(out, /data-testid="machine-channel-value"[^>]*>main/);
		assert.match(out, /Change it from that machine&#x27;s console/);
		assert.ok(!out.includes("machine-channel-select"));
	});

	it("an offline machine says Offline and offers no Restart", () => {
		const out = html(host({ workerds: [{ link: link("workerd", "workerd", { status: "down", error: "host_offline" }), wolves: [] }] }), null);
		assert.match(out, /data-testid="machine-online"[^>]*>Offline/);
		assert.ok(!out.includes('data-testid="machine-restart"'));
		assert.match(out, /data-testid="machine-offline-note"/);
	});

	it("a down service shows its fetched log lines exactly as sent", () => {
		const c = host({ commands: ["logs.fetch"], workerds: [{ link: link("workerd", "workerd", { status: "down", error: "refused" }), wolves: [] }, ] });
		c.workerds[0]!.wolves = [link("wolfd@ada", "wolfd")];
		const out = html(c, null, { workerd: { lines: ["boom  token=abc <x>"], error: null } });
		assert.match(out, /data-service="workerd" data-down="true"/);
		assert.match(out, /boom {2}token=abc &lt;x&gt;/);
	});

	it("a down service row carries its own Restart when advertised, with the result line under that row", () => {
		const c = host({ commands: ["wolves.restart", "workerd.restart"], hub: link("hubd", "hubd"), workerds: [{ link: link("workerd", "workerd", { status: "down", error: "refused" }), wolves: [] }] });
		const out = renderToStaticMarkup(<MachineCard view={machineCard(c, null)} logs={{}} notes={{ workerd: "restarting; the machine will reconnect" }} />);
		assert.match(out, /data-service="workerd" data-down="true".*data-testid="machine-restart" data-for="workerd"/s);
		assert.equal(out.split('data-testid="machine-restart"').length - 1, 1);
		assert.match(out, /data-testid="machine-service-note"[^>]*>restarting; the machine will reconnect/);
	});

	it("a down background service that was not advertised shows the Mac hint on a Mac, and the console's own card has a channel picker", () => {
		const mac = html(host({ id: "luka-air", label: "Mac", console: true, commands: ["wolves.restart"], facts: { host: "Mac", services: [], stores: [], backups: "" }, hub: link("hubd", "hubd"), workerds: [{ link: link("workerd", "workerd", { status: "down", error: "refused" }), wolves: [] }] }), "stable");
		assert.match(mac, /data-testid="machine-restart-hint"[^>]*>Restart isn&#x27;t available on the Mac app; quit and reopen it/);
		assert.ok(!mac.includes('data-testid="machine-restart"'));
		assert.match(mac, /data-testid="machine-channel-select"/);
	});
});
