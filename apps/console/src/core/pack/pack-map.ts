/**
 * Where the pack runs (work-wolfpack-6imFEq7): a static map for the health modal. Data only; every line comes from the repo:
 *   sfo-01: deploy/hubd/RUNBOOK.md (Target state, backup section), deploy/console/RUNBOOK.md (env table),
 *           deploy/workerd/workerd.env.example, infra/wolves/README.md (units, Backups).
 *   Mac:    scripts/stack.mjs (com.wolfpack.stack launchd agent, STACK_PORT default 7141), packages/workerd/src/proxy.ts
 *           (listens on 127.0.0.1 by default), packages/workerd/src/hub-config.ts + run.ts (~/.wolfpack/workerd: hub.json,
 *           kb-mirror/), README.md (log ~/wolves/local/logs/stack.log), scripts/dev-stack.mjs (dev:stack workerd 7151,
 *           console 3220, sandbox ~/wolves/dev-sandbox), docs/dev-sandbox.md (`wolfpack preview` console 3230, slots 3231-3234),
 *           docs/architecture.md (Syncthing carries den backups only).
 *   No tailnet IPs here: the modal shows hubd as "tailnet :3150". Change it when those sources change.
 */

export interface PackMapService {
	name: string;
	/** Where it listens. */
	at: string;
	what: string;
}

export interface PackMapStore {
	name: string;
	path: string;
}

export interface PackMapHost {
	host: string;
	services: PackMapService[];
	stores: PackMapStore[];
	/** How it is backed up, in one line. */
	backups: string;
}

export const PACK_MAP: PackMapHost[] = [
	{
		host: "sfo-01",
		services: [
			{ name: "hubd", at: "tailnet :3150", what: "the hub: registry, tokens, work ledger, KB curator" },
			{ name: "console", at: "127.0.0.1:3200 (tailscale serve /)", what: "this console" },
			{ name: "workerd", at: "127.0.0.1:7142", what: "link-only: hub link + KB sync, spawns nothing" },
			{ name: "workerd-wolves", at: "127.0.0.1:7143", what: "supervises the wolfd@<name> units" },
			{ name: "wolfd@<name>", at: "unix socket /run/wolfd-<name>/serve.sock", what: "one wolf, dialled only by workerd-wolves" },
		],
		stores: [
			{ name: "hub data", path: "/var/lib/hubd (HUBD_DATA_DIR)" },
			{ name: "KB", path: "/var/lib/hubd/kb/base/domains" },
			{ name: "KB mirror (workerd)", path: "/var/lib/workerd-kb" },
			{ name: "console data", path: "/var/lib/console/data (WOLFPACK_DATA_DIR)" },
			{ name: "wolf homes", path: "/home/wolf-<name> (den/, wolf.yaml, agent/)" },
		],
		backups: "hub: tar of /var/lib/hubd with hubd stopped (deploy/hubd/RUNBOOK.md; hubd export does not work here). Wolves: per-wolf backup is a recommendation only (infra/wolves/README.md).",
	},
	{
		host: "Mac",
		services: [
			{ name: "workerd (live stack)", at: "127.0.0.1:7141", what: "launchd agent com.wolfpack.stack: supervises one wolfd per wolf in ~/wolves/local" },
			{ name: "preview console", at: "127.0.0.1:3230", what: "`wolfpack preview`; agent preview slots on 3231-3234" },
			{ name: "dev stack", at: "workerd 7151, console 3220", what: "`pnpm run dev:stack`: the current checkout against ~/wolves/dev-sandbox" },
		],
		stores: [
			{ name: "hub link + KB mirror", path: "~/.wolfpack/workerd (hub.json, kb-mirror/)" },
			{ name: "stack log", path: "~/wolves/local/logs/stack.log" },
		],
		backups: "dens via Syncthing (den backups only; docs/architecture.md)",
	},
];
