"use client";

/**
 * The up-front part of the graph settings panel (work-wolfpack-H1OQNIh): a preset segmented control, Group by and Domain,
 * three switches (Live, Board, Labels) and two sliders (Spread, Soft regions). All state lives in the same GraphRenderSettings the
 * Advanced section edits; the mappings and presets are pure (src/core/graph/simple-settings.ts), so an Advanced edit moves these
 * controls and shows the preset as "Custom".
 *
 * Mac-style: translucent controls, hairline borders, a sliding segmented thumb and switch thumbs on a short spring (a CSS cubic-bezier
 * with overshoot, switched off under prefers-reduced-motion), lucide icons with tooltips and aria-labels, theme variables only.
 * Phone (below md): rows are at least 44 px high.
 *
 * "Board" is the work layer the graph can toggle: `layers.archivedWork` (open work is always on, so the switch shows the finished
 * work cards next to it).
 */

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { osPrefersReducedMotion, type MotionMode } from "@/src/core";
import { Blend, Brain, EyeOff, Expand, Ghost, Gauge, Kanban, LayoutGrid, Layers, Radio, Route, Tags } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import {
	PRESET_IDS,
	applyPreset,
	detectPreset,
	labelsOn,
	setLabels,
	softRegionsFromTuning,
	softRegionsToTuning,
	spreadFromPhysics,
	spreadToPhysics,
	formatLiveSeconds,
	liveSecondsFromPosition,
	liveSecondsToPosition,
	type GraphRenderSettings,
	type GroupBy,
	type KbGraphDomain,
	type PresetId,
} from "@/src/core";

type Change = (update: (cur: GraphRenderSettings) => GraphRenderSettings) => void;
type IconType = ComponentType<{ className?: string }>;

/** A short spring: overshoots a little, 200 ms. Off under prefers-reduced-motion. */
const SPRING = "transition-transform duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:transition-none";

const PRESET_META: Record<PresetId, { label: string; hint: string; Icon: IconType }> = {
	overview: { label: "Overview", hint: "Everything, grouped by domain, soft regions and labels", Icon: LayoutGrid },
	"by-domain": { label: "By domain", hint: "Tighter clusters per domain", Icon: Layers },
	live: { label: "Live", hint: "Show the pack live, with lighter labels", Icon: Radio },
};

export function PresetControl({ settings, changeSettings }: { settings: GraphRenderSettings; changeSettings: Change }) {
	const active = detectPreset(settings);
	const index = PRESET_IDS.indexOf(active as PresetId);
	return (
		<div className="flex flex-col gap-1">
			<div
				role="radiogroup"
				aria-label="Graph preset"
				className="relative grid grid-cols-3 rounded-[10px] bg-muted/70 p-0.5 ring-1 ring-border/60"
			>
				{index >= 0 && (
					<span
						aria-hidden
						className={`pointer-events-none absolute inset-y-0.5 left-0.5 w-[calc((100%-0.25rem)/3)] rounded-[8px] bg-background shadow-sm ring-1 ring-border/60 ${SPRING}`}
						style={{ transform: `translateX(${index * 100}%)` }}
					/>
				)}
				{PRESET_IDS.map((id) => {
					const { label, hint, Icon } = PRESET_META[id];
					return (
						<Hint key={id} label={hint} side="bottom">
							<button
								type="button"
								role="radio"
								aria-checked={active === id}
								aria-label={label}
								onClick={() => changeSettings((cur) => applyPreset(id, cur))}
								className={`relative z-10 flex min-h-11 items-center justify-center gap-1 rounded-[8px] px-1 text-[11px] font-medium md:min-h-7 ${
									active === id ? "text-foreground" : "text-muted-foreground hover:text-foreground"
								}`}
							>
								<Icon className="size-3.5" />
								{label}
							</button>
						</Hint>
					);
				})}
			</div>
			{active === "custom" && <span className="px-1 text-[10px] text-muted-foreground">Custom</span>}
		</div>
	);
}

function Switch({
	label,
	hint,
	Icon,
	checked,
	onChange,
}: {
	label: string;
	hint: string;
	Icon: IconType;
	checked: boolean;
	onChange: (on: boolean) => void;
}) {
	return (
		<Hint label={hint} side="bottom">
			<button
				type="button"
				role="switch"
				aria-checked={checked}
				aria-label={label}
				onClick={() => onChange(!checked)}
				className="flex min-h-11 flex-1 flex-col items-center justify-center gap-1 rounded-[10px] px-1 text-[11px] text-muted-foreground hover:bg-accent/60 md:min-h-0 md:py-1.5"
			>
				<span className="flex items-center gap-1">
					<Icon className={`size-3.5 ${checked ? "text-foreground" : ""}`} />
					{label}
				</span>
				<span
					aria-hidden
					className={`relative h-[18px] w-[30px] rounded-full ring-1 ring-border/60 transition-colors motion-reduce:transition-none ${
						checked ? "bg-primary" : "bg-muted"
					}`}
				>
					<span
						className={`absolute left-[2px] top-[2px] size-[14px] rounded-full bg-background shadow ${SPRING}`}
						style={{ transform: `translateX(${checked ? 12 : 0}px)` }}
					/>
				</span>
			</button>
		</Hint>
	);
}

function SimpleSlider({
	label,
	hint,
	Icon,
	value,
	onChange,
}: {
	label: string;
	hint: string;
	Icon: IconType;
	value: number;
	onChange: (n: number) => void;
}) {
	return (
		<Hint label={hint} side="bottom">
			<label className="flex min-h-11 items-center gap-2 md:min-h-7">
				<Icon className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="w-16 shrink-0 text-[11px] text-muted-foreground">{label}</span>
				<input
					type="range"
					min={0}
					max={100}
					step={1}
					value={Math.round(value)}
					aria-label={label}
					onChange={(e) => onChange(Number(e.target.value))}
					className="h-6 w-full accent-primary md:h-1.5"
				/>
			</label>
		</Hint>
	);
}

/** A seconds slider on the non-linear live scale (0-60 s gets most of the travel); the value shows as "15s" / "2m". */
function SecondsSlider({
	label,
	hint,
	Icon,
	value,
	onChange,
}: {
	label: string;
	hint: string;
	Icon: IconType;
	value: number;
	onChange: (sec: number) => void;
}) {
	return (
		<Hint label={hint} side="bottom">
			<label className="flex min-h-11 items-center gap-2 md:min-h-7">
				<Icon className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="w-16 shrink-0 text-[11px] text-muted-foreground">{label}</span>
				<input
					type="range"
					min={0}
					max={100}
					step={1}
					value={Math.round(liveSecondsToPosition(value))}
					aria-label={label}
					aria-valuetext={formatLiveSeconds(value)}
					onChange={(e) => onChange(liveSecondsFromPosition(Number(e.target.value)))}
					className="h-6 w-full accent-primary md:h-1.5"
				/>
				<span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-foreground">{formatLiveSeconds(value)}</span>
			</label>
		</Hint>
	);
}

/** 'Live map motion': follow the system's Reduce motion switch, or always animate. */
function MotionControl({ value, onChange }: { value: MotionMode; onChange: (m: MotionMode) => void }) {
	const [osReduced, setOsReduced] = useState(false);
	useEffect(() => {
		setOsReduced(osPrefersReducedMotion());
	}, []);
	const options: { id: MotionMode; label: string }[] = [
		{ id: "follow", label: "Follow system" },
		{ id: "always", label: "Always animate" },
	];
	return (
		<div className="flex flex-col gap-1 py-1">
			<div className="flex min-h-11 items-center gap-2 md:min-h-7">
				<span className="w-16 shrink-0 text-[11px] text-muted-foreground">Live map motion</span>
				<div role="radiogroup" aria-label="Live map motion" className="grid min-w-0 flex-1 grid-cols-2 rounded-[8px] bg-muted/70 p-0.5 ring-1 ring-border/60">
					{options.map((o) => (
						<button
							key={o.id}
							type="button"
							role="radio"
							aria-checked={value === o.id}
							onClick={() => onChange(o.id)}
							className={`flex min-h-11 items-center justify-center rounded-[6px] px-1 text-[11px] md:min-h-6 ${
								value === o.id ? "bg-background text-foreground shadow-sm ring-1 ring-border/60" : "text-muted-foreground hover:text-foreground"
							}`}
						>
							{o.label}
						</button>
					))}
				</div>
			</div>
			{value === "follow" && osReduced ? (
				<p className="text-[10px] leading-snug text-muted-foreground">Your system has Reduce motion on: wolves show state but don't move.</p>
			) : null}
		</div>
	);
}

/** Animation intensity 1 (minimal) to 5 (lively), a segmented control. */
function IntensityControl({ value, onChange }: { value: number; onChange: (n: number) => void }) {
	return (
		<Hint label="Animation intensity: 1 is minimal, 5 is lively. Reduced motion only stops movement." side="bottom">
			<div className="flex min-h-11 items-center gap-2 md:min-h-7">
				<Gauge className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="w-16 shrink-0 text-[11px] text-muted-foreground">Intensity</span>
				<div role="radiogroup" aria-label="Animation intensity" className="grid min-w-0 flex-1 grid-cols-5 rounded-[8px] bg-muted/70 p-0.5 ring-1 ring-border/60">
					{[1, 2, 3, 4, 5].map((n) => (
						<button
							key={n}
							type="button"
							role="radio"
							aria-checked={value === n}
							aria-label={`Intensity ${n}`}
							onClick={() => onChange(n)}
							className={`flex min-h-11 items-center justify-center rounded-[6px] text-[11px] tabular-nums md:min-h-6 ${
								value === n ? "bg-background text-foreground shadow-sm ring-1 ring-border/60" : "text-muted-foreground hover:text-foreground"
							}`}
						>
							{n}
						</button>
					))}
				</div>
			</div>
		</Hint>
	);
}

const SELECT =
	"min-h-11 max-w-40 rounded-[8px] border border-border/60 bg-background/70 px-2 text-xs text-foreground md:min-h-0 md:px-1.5 md:py-0.5";

export function SimpleControls({
	settings,
	changeSettings,
	domains,
	children,
}: {
	settings: GraphRenderSettings;
	changeSettings: Change;
	domains: readonly KbGraphDomain[];
	/** The Advanced section, rendered under the simple controls. */
	children?: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-2">
			<PresetControl settings={settings} changeSettings={changeSettings} />
			<div className="flex items-center justify-between gap-2">
				<label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
					<Hint label="Group by" side="bottom">
						<span className="flex">
							<Layers className="size-3.5" />
						</span>
					</Hint>
					<select
						aria-label="Group by"
						className={SELECT}
						value={settings.groupBy}
						onChange={(e) => changeSettings((cur) => ({ ...cur, groupBy: e.target.value as GroupBy }))}
					>
						<option value="domain">Domain</option>
						<option value="section">Section</option>
					</select>
				</label>
				<select
					aria-label="Domain"
					className={SELECT}
					value={settings.domain ?? ""}
					onChange={(e) => changeSettings((cur) => ({ ...cur, domain: e.target.value || null }))}
				>
					<option value="">All domains</option>
					{settings.domain && !domains.some((d) => d.name === settings.domain) && (
						<option value={settings.domain}>{settings.domain}</option>
					)}
					{domains.map((d) => (
						<option key={d.name} value={d.name}>
							{d.label}
						</option>
					))}
				</select>
			</div>
			<div className="flex items-stretch gap-1">
				<Switch
					label="Live"
					hint="Show wolves and threads live on the graph"
					Icon={Radio}
					checked={settings.live.enabled}
					onChange={(on) => changeSettings((cur) => ({ ...cur, live: { ...cur.live, enabled: on } }))}
				/>
				<Switch
					label="Board"
					hint="Show the work board: features, tasks and their links"
					Icon={Kanban}
					checked={settings.layers.work}
					onChange={(on) => changeSettings((cur) => ({ ...cur, layers: { ...cur.layers, work: on } }))}
				/>
				<Switch
					label="Labels"
					hint="Region and node labels"
					Icon={Tags}
					checked={labelsOn(settings)}
					onChange={(on) => changeSettings((cur) => setLabels(cur, on))}
				/>
				<Switch
					label="Private"
					hint="Private view: blur titles and personal details on the graph, the overlay and the feed"
					Icon={EyeOff}
					checked={settings.privateView}
					onChange={(on) => changeSettings((cur) => ({ ...cur, privateView: on }))}
				/>
			</div>
			<SimpleSlider
				label="Spread"
				hint="How far apart the nodes sit"
				Icon={Expand}
				value={spreadFromPhysics(settings.physics)}
				onChange={(n) => changeSettings((cur) => ({ ...cur, physics: spreadToPhysics(n, cur.physics) }))}
			/>
			<SimpleSlider
				label="Soft regions"
				hint="How wide and soft the region glow is"
				Icon={Blend}
				value={softRegionsFromTuning(settings.regions)}
				onChange={(n) => changeSettings((cur) => ({ ...cur, regions: softRegionsToTuning(n, cur.regions) }))}
			/>
			<div
				role="group"
				aria-label="Live overlay"
				aria-disabled={!settings.live.enabled}
				className={`flex flex-col rounded-[10px] border border-border/50 px-2 py-1 transition-opacity motion-reduce:transition-none ${settings.live.enabled ? "" : "pointer-events-none opacity-45"}`}
			>
				<span className="flex items-center gap-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
					<Radio className="size-3" />
					Live{settings.live.enabled ? "" : " · off"}
				</span>
				<SecondsSlider
					label="Fade-out"
					hint="How long a subagent stays on the graph after it finishes"
					Icon={Ghost}
					value={settings.live.subagentFadeSec}
					onChange={(sec) => changeSettings((cur) => ({ ...cur, live: { ...cur.live, subagentFadeSec: sec } }))}
				/>
				<SecondsSlider
					label="Trails"
					hint="How long the trail to a touched node stays visible"
					Icon={Route}
					value={settings.live.trailSec}
					onChange={(sec) => changeSettings((cur) => ({ ...cur, live: { ...cur.live, trailSec: sec } }))}
				/>
				<IntensityControl
					value={settings.live.intensity}
					onChange={(n) => changeSettings((cur) => ({ ...cur, live: { ...cur.live, intensity: n } }))}
				/>
				<div className="flex items-stretch gap-1">
					<Switch
						label="Memory"
						hint="Show the memory and KB animations"
						Icon={Brain}
						checked={settings.live.memory}
						onChange={(on) => changeSettings((cur) => ({ ...cur, live: { ...cur.live, memory: on } }))}
					/>
				</div>
				<MotionControl value={settings.live.motion} onChange={(m) => changeSettings((cur) => ({ ...cur, live: { ...cur.live, motion: m } }))} />
			</div>
			{children}
		</div>
	);
}
