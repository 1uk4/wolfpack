"use client";
import { type CSSProperties, useState } from "react";

type Look = {
	id: string;
	name: string;
	chrome: string;
	mono: string;
	prose: string;
	title: string;
	titleWeight: number;
	titleSize: number;
	bg: string;
	surface: string;
	raised: string;
	border: string;
	muted: string;
	text: string;
	accent: string;
	accentText: string;
	radius: number;
	pill: number;
	gap: number;
};

const LOOKS: Look[] = [
	{
		id: "A", name: "Warm terminal",
		chrome: "var(--f-geist-mono), monospace", mono: "var(--f-geist-mono), monospace",
		prose: "var(--f-source), sans-serif", title: "var(--f-instrument), serif", titleWeight: 400, titleSize: 44,
		bg: "#151311", surface: "#1d1a17", raised: "#2a2622", border: "#3d3832", muted: "#948b80", text: "#ece6dd",
		accent: "#e0a040", accentText: "#1a1307", radius: 8, pill: 999, gap: 14,
	},
	{
		id: "B", name: "Clean modern",
		chrome: "var(--f-geist), sans-serif", mono: "var(--f-geist-mono), monospace",
		prose: "var(--f-geist), sans-serif", title: "var(--f-geist), sans-serif", titleWeight: 600, titleSize: 30,
		bg: "#0f1012", surface: "#17181b", raised: "#222428", border: "#33363c", muted: "#8b9099", text: "#e8eaed",
		accent: "#6e9cff", accentText: "#06101f", radius: 10, pill: 10, gap: 14,
	},
	{
		id: "C", name: "Editorial",
		chrome: "var(--f-inter), sans-serif", mono: "var(--f-jb), monospace",
		prose: "var(--f-inter), sans-serif", title: "var(--f-newsreader), serif", titleWeight: 500, titleSize: 40,
		bg: "#121110", surface: "#1a1918", raised: "#262422", border: "#3a3734", muted: "#9a948c", text: "#f0ebe3",
		accent: "#d0805a", accentText: "#1d0e07", radius: 6, pill: 999, gap: 20,
	},
];

const B_VARIATIONS: Look[] = [
	{
		id: "B1", name: "Original B",
		chrome: "var(--f-geist), sans-serif", mono: "var(--f-geist-mono), monospace",
		prose: "var(--f-geist), sans-serif", title: "var(--f-geist), sans-serif", titleWeight: 600, titleSize: 30,
		bg: "#0f1012", surface: "#17181b", raised: "#222428", border: "#33363c", muted: "#8b9099", text: "#e8eaed",
		accent: "#6e9cff", accentText: "#06101f", radius: 10, pill: 10, gap: 14,
	},
	{
		id: "B2", name: "Mono-accent (Vercel-like)",
		chrome: "var(--f-geist), sans-serif", mono: "var(--f-geist-mono), monospace",
		prose: "var(--f-geist), sans-serif", title: "var(--f-geist), sans-serif", titleWeight: 600, titleSize: 30,
		bg: "#0a0a0a", surface: "#111111", raised: "#1a1a1a", border: "#2e2e2e", muted: "#8f8f8f", text: "#ededed",
		accent: "#ededed", accentText: "#0a0a0a", radius: 8, pill: 8, gap: 14,
	},
	{
		id: "B3", name: "Violet",
		chrome: "var(--f-geist), sans-serif", mono: "var(--f-geist-mono), monospace",
		prose: "var(--f-geist), sans-serif", title: "var(--f-geist), sans-serif", titleWeight: 600, titleSize: 30,
		bg: "#0f1012", surface: "#17181b", raised: "#222428", border: "#33363c", muted: "#8b9099", text: "#e8eaed",
		accent: "#8b7cf6", accentText: "#0d0a24", radius: 10, pill: 10, gap: 14,
	},
	{
		id: "B4", name: "Slate and teal",
		chrome: "var(--f-inter), sans-serif", mono: "var(--f-geist-mono), monospace",
		prose: "var(--f-inter), sans-serif", title: "var(--f-inter), sans-serif", titleWeight: 600, titleSize: 30,
		bg: "#0f141a", surface: "#161c24", raised: "#1f2730", border: "#313b47", muted: "#8a96a3", text: "#e6ebf0",
		accent: "#2dd4bf", accentText: "#04201c", radius: 10, pill: 10, gap: 14,
	},
	{
		id: "B5", name: "Soft",
		chrome: "var(--f-plex), sans-serif", mono: "var(--f-plex-mono), monospace",
		prose: "var(--f-plex), sans-serif", title: "var(--f-plex), sans-serif", titleWeight: 600, titleSize: 30,
		bg: "#18181b", surface: "#1f1f23", raised: "#27272a", border: "#3f3f46", muted: "#a1a1aa", text: "#f4f4f5",
		accent: "#7aa2f7", accentText: "#0a1428", radius: 12, pill: 12, gap: 18,
	},
	{
		id: "B6", name: "Warm modern",
		chrome: "var(--f-geist), sans-serif", mono: "var(--f-geist-mono), monospace",
		prose: "var(--f-geist), sans-serif", title: "var(--f-geist), sans-serif", titleWeight: 600, titleSize: 30,
		bg: "#121212", surface: "#1a1a19", raised: "#252523", border: "#383835", muted: "#8e8c86", text: "#ecebe8",
		accent: "#f0a848", accentText: "#201403", radius: 10, pill: 10, gap: 14,
	},
];

const CURRENT: Look = {
	id: "0", name: "Current (baseline)",
	chrome: "'JetBrains Mono', ui-monospace, monospace", mono: "'JetBrains Mono', ui-monospace, monospace",
	prose: "'Source Sans 3', system-ui, sans-serif", title: "'CMU Serif', 'Latin Modern Roman', Georgia, serif", titleWeight: 400, titleSize: 40,
	bg: "#141414", surface: "#1c1c1c", raised: "#2a2a2a", border: "#434343", muted: "#8d8d8d", text: "#e6e6e6",
	accent: "#e6e6e6", accentText: "#141414", radius: 8, pill: 999, gap: 14,
};

const THREADS = [
	{ n: "1uk4", c: "#5fb37c" },
	{ n: "hal", c: "#c9a14a" },
	{ n: "sfo-01", c: "#6e9cff" },
	{ n: "kb-sweep", c: "#b07ad6" },
	{ n: "preview", c: "#8d8d8d" },
];

function Panel({ look, phone }: { look: Look; phone: boolean }) {
	const L = look;
	const st = { fontFamily: L.chrome, background: L.bg, color: L.text } as CSSProperties;
	const border = `1px solid ${L.border}`;
	const mono = { fontFamily: L.mono } as CSSProperties;
	const pillBtn = (extra: CSSProperties = {}): CSSProperties => ({
		border, borderRadius: L.pill, padding: "2px 10px", fontSize: 12, background: "transparent", color: L.text, ...extra,
	});
	return (
		<div style={{ ...st, width: phone ? 390 : "100%", height: 600, display: "flex", overflow: "hidden", border, borderRadius: L.radius, flex: "none" }}>
			<aside style={{ width: phone ? 64 : 200, background: L.surface, borderRight: border, padding: 10, display: "flex", flexDirection: "column", gap: 4, flex: "none" }}>
				<div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 4px 12px" }}>
					<svg width={22} height={22} viewBox="0 0 64 64" fill={L.text} fillRule="evenodd" style={{ flex: "none" }} role="img" aria-label="Wolfpack">
						<path d="M8 2L24 18H40L56 2L57 27L63 33L52 39L32 62L12 39L1 33L7 27Z M16 28L27 32L19.5 35.5Z M48 28L37 32L44.5 35.5Z" />
					</svg>
					{!phone && <span style={{ fontFamily: L.title, fontWeight: 600, fontSize: 15, letterSpacing: L.id.startsWith("B") ? -0.2 : 0 }}>Wolfpack</span>}
				</div>
				{THREADS.map((t, i) => {
					const active = i === 0;
					return (
						<div key={t.n} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: L.radius, fontSize: 13, background: active ? L.raised : "transparent", borderLeft: `2px solid ${active ? L.accent : "transparent"}`, color: active ? L.text : L.muted }}>
							<span style={{ width: 8, height: 8, borderRadius: 99, background: t.c, flex: "none" }} />
							{!phone && t.n}
						</div>
					);
				})}
			</aside>
			<main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
				<header style={{ padding: `${L.gap}px 20px`, borderBottom: border }}>
					<div style={{ fontFamily: L.title, fontWeight: L.titleWeight, fontSize: L.titleSize, lineHeight: 1.05, letterSpacing: L.id.startsWith("B") ? -0.5 : 0 }}>1uk4</div>
					<div style={{ color: L.muted, fontSize: 12, marginTop: 4, ...mono }}>claude-opus · main · 3 tasks · 12m ago</div>
				</header>
				<div style={{ flex: 1, overflow: "auto", padding: `${L.gap + 4}px 20px`, display: "flex", flexDirection: "column", gap: L.gap + 6, fontFamily: L.prose, fontSize: 15, lineHeight: 1.55 }}>
					<div style={{ alignSelf: "flex-end", maxWidth: "80%", background: L.raised, border, borderRadius: L.radius + 4, padding: "8px 12px" }}>
						Can you check why the sweep stalled overnight?
					</div>
					<div style={{ maxWidth: "92%" }}>
						<div style={{ fontFamily: L.title, fontWeight: L.titleWeight, fontSize: 22, marginBottom: 4 }}>Sweep diagnosis</div>
						<p style={{ margin: 0 }}>
							The worker hit a <b>lock timeout</b> on the ledger, so it <i>never released</i> the lease. Setting <code style={{ ...mono, fontSize: 13, background: L.raised, padding: "1px 5px", borderRadius: 4 }}>sweep.lease_ttl</code> lower should clear it:
						</p>
						<pre style={{ ...mono, fontSize: 12.5, background: L.surface, border, borderRadius: L.radius, padding: 12, margin: "10px 0 0", overflow: "auto", color: L.text }}>
{`$ wolfpack kb sweep --lease-ttl 60
sweep: acquired lease (60s)
sweep: 24 entries merged`}
						</pre>
					</div>
					<div style={{ alignSelf: "flex-end", maxWidth: "80%", background: L.raised, border, borderRadius: L.radius + 4, padding: "8px 12px" }}>
						Great, run it.
					</div>
				</div>
				<div style={{ margin: "0 16px 8px", border, background: L.surface, borderRadius: L.radius, padding: "6px 12px", display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
					<span style={{ width: 8, height: 8, borderRadius: 99, background: "#5fb37c" }} />
					<span style={{ fontWeight: 600 }}>kb-sweep</span>
					<span style={{ color: L.muted, flex: 1 }}>working</span>
					<button type="button" style={pillBtn({ borderColor: L.accent, color: L.accent })}>Stop</button>
				</div>
				<div style={{ margin: "0 16px 16px", border, background: L.surface, borderRadius: L.radius + 6, padding: 10, boxShadow: `0 0 0 1px ${L.accent}33` }}>
					<div style={{ fontFamily: L.prose, color: L.muted, fontSize: 15, padding: "4px 6px 12px" }}>Message the wolf…</div>
					<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
						<button type="button" style={{ ...pillBtn(), width: 30, height: 30, padding: 0, fontSize: 16, color: L.muted }}>+</button>
						<span style={pillBtn({ color: L.muted })}>main ▾</span>
						<div style={{ flex: 1, height: 26, borderRadius: L.pill, background: L.raised, color: L.muted, fontSize: 12, display: "flex", alignItems: "center", padding: "0 12px" }}>● Dictate</div>
						<button type="button" style={{ width: 30, height: 30, borderRadius: L.pill, border: "none", background: L.accent, color: L.accentText, fontWeight: 700 }}>↑</button>
					</div>
				</div>
			</main>
		</div>
	);
}

function Toggle({ on, set, opts }: { on: string; set: (v: string) => void; opts: string[] }) {
	return (
		<div style={{ display: "inline-flex", border: "1px solid #434343", borderRadius: 999, overflow: "hidden" }}>
			{opts.map((o) => (
				<button key={o} type="button" onClick={() => set(o)} style={{ padding: "4px 14px", fontSize: 13, background: on === o ? "#e6e6e6" : "transparent", color: on === o ? "#141414" : "#e6e6e6", border: "none", cursor: "pointer" }}>
					{o}
				</button>
			))}
		</div>
	);
}

export default function LooksPage() {
	const [width, setWidth] = useState("Wide");
	const [cur, setCur] = useState("Off");
	const phone = width === "Phone";
	const [abc, setAbc] = useState("Off");
	const rest = [...(abc === "On" ? LOOKS : []), ...(cur === "On" ? [CURRENT] : [])];
	const list = [...B_VARIATIONS, ...rest];
	return (
		<div style={{ background: "#0a0a0a", color: "#e6e6e6", minHeight: "100vh", padding: 24, fontFamily: "system-ui, sans-serif" }}>
			<div style={{ display: "flex", gap: 20, alignItems: "center", marginBottom: 20, flexWrap: "wrap" }}>
				<h1 style={{ fontSize: 18, margin: 0 }}>Console looks preview (temporary)</h1>
				<Toggle on={width} set={setWidth} opts={["Wide", "Phone"]} />
				<span style={{ fontSize: 13 }}>Current baseline</span>
				<Toggle on={cur} set={setCur} opts={["Off", "On"]} />
				<span style={{ fontSize: 13 }}>Show A / B / C</span>
				<Toggle on={abc} set={setAbc} opts={["Off", "On"]} />
			</div>
			<div style={{ display: "flex", flexDirection: "column", gap: 28, overflowX: "auto" }}>
				{list.map((l) => (
					<section key={l.id}>
						{l.id === "B1" && <h2 style={{ fontSize: 20, margin: "0 0 12px", color: "#e6e6e6" }}>B variations</h2>}
						<h2 style={{ fontSize: 14, margin: "0 0 8px", color: "#8d8d8d" }}>
							{l.id === "0" ? l.name : `${l.id}. ${l.name}`}
						</h2>
						<Panel look={l} phone={phone} />
					</section>
				))}
			</div>
		</div>
	);
}
