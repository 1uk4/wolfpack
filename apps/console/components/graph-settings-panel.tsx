"use client";

/**
 * The graph's settings gear + its collapsible panel: the KB-graph VIEW
 * (group by, optional layers, domain filter), then display (sizes, label
 * zoom), Regions and Physics. Every control writes through changeSettings;
 * the owner (graph-home) persists them server-side.
 */

import { useRef, useState } from "react";
import { SettingsIcon } from "lucide-react";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { Hint } from "@/components/ui/hint";
import {
	CHARGE_RANGE,
	CLUSTER_LABEL_SIZE_LADDER,
	CLUSTER_PULL_RANGE,
	DEPTH_BASE_RADIUS_RANGE,
	DEPTH_SPACING_RANGE,
	DEPTH_STRENGTH_RANGE,
	EDGE_WIDTH_LADDER,
	GRAVITY_RANGE,
	LABEL_SIZE_LADDER,
	LABEL_ZOOM_LADDER,
	LINK_DISTANCE_RANGE,
	LINK_STRENGTH_RANGE,
	NODE_SIZE_LADDER,
	REGION_BITMAP_OPTIONS,
	REGION_BLUR_LADDER,
	REGION_DILATION_LADDER,
	REGION_EDGE_ALPHA_LADDER,
	VELOCITY_DECAY_RANGE,
	fromLadderPosition,
	fromOffSliderPosition,
	fromSliderPosition,
	labelZoomDisplay,
	toLadderPosition,
	toOffSliderPosition,
	toSliderPosition,
	type GraphRenderSettings,
	type GroupBy,
	type KbGraphDomain,
} from "@/src/core";

type RenderSettings = GraphRenderSettings;

/** Compact size display for the log sliders: "2", "1.6", "0.75". */
function sizeDisplay(v: number): string {
	return `${v >= 1 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100}`;
}

function SettingSlider({
	label,
	min,
	max,
	step,
	value,
	display,
	onChange,
	disabled,
}: {
	label: string;
	min: number;
	max: number;
	step: number;
	value: number;
	/** Value display override (e.g. "1.5×" for zoom) — defaults to the raw number. */
	display?: string;
	onChange: (v: number) => void;
	/** Dependency graying (user 2026-09-17): children dim + lock when
	 *  their parent toggle/mode is off — consistently across sections. */
	disabled?: boolean;
}) {
	return (
		<label className={`flex flex-col gap-1${disabled ? " opacity-40" : ""}`}>
			<span className="flex items-center justify-between text-[11px] text-muted-foreground">
				{label}
				<span className="tabular-nums">{display ?? value}</span>
			</span>
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				disabled={disabled}
				onChange={(e) => onChange(Number(e.target.value))}
				className="h-1.5 w-full accent-primary"
			/>
		</label>
	);
}

/**
 * The rendering-settings gear + its collapsible panel (owner, graph-view
 * round 2): its own container at the top right, separate from the search
 * box — clicking the gear expands/collapses the panel, which drops below
 * the button, right-aligned with it.
 */
export function GraphSettingsControl({
	settings,
	changeSettings,
	domains,
}: {
	settings: GraphRenderSettings;
	changeSettings: (update: (cur: RenderSettings) => RenderSettings) => void;
	/** The domains the librarian reports (the filter's options). */
	domains: readonly KbGraphDomain[];
}) {
	const [open, setOpen] = useState(false);
	// Click anywhere outside (or Escape) closes the panel (2026-09-17) —
	// the root wraps button + panel, so the toggle itself keeps working.
	const rootRef = useRef<HTMLDivElement>(null);
	usePopoverDismiss(rootRef, open, () => setOpen(false));
	const regionTuning = settings.regions;
	const physicsTuning = settings.physics;
	return (
		<div ref={rootRef} className="relative">
			<Hint
				// User language (tooltip wave) — "rendering" is internal.
				label="Graph display settings"
				side="bottom"
			>
				<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				className={`flex size-9 items-center justify-center rounded-xl border bg-card/85 shadow-lg backdrop-blur transition-colors hover:bg-accent ${
					open ? "text-foreground" : "text-muted-foreground hover:text-foreground"
				}`}
			>
				<SettingsIcon className="size-4" />
			</button>
			</Hint>
			{open && (
				// Viewport-capped + internally scrollable — the coverage
				// dropdown's exact pattern (owner, 2026-09-17): max-h keeps a
				// floor of free space above the window bottom at any height,
				// and the overflow-y-auto column (which also zeroes the flex
				// item's min-height) scrolls instead of stretching the page.
				// w-72 + inner pr (owner, 2026-09-20): the scrollbar used to
				// press against the content — the panel widens so the scroll
				// gutter gets real air. Spacing concentric: content -> 10px
				// (pr-2.5) -> scrollbar -> 10px (p-2.5) -> panel edge. The
				// scrollbar itself does NOT move: it stays pinned at the same
				// distance from the panel's right border.
				<div className="absolute right-0 top-full mt-2 flex max-h-[60vh] w-72 flex-col rounded-xl border bg-card/85 p-2.5 shadow-lg backdrop-blur">
					<div className="flex flex-col gap-2 overflow-y-auto pr-2.5">
						{/* The KB-graph view: what the regions group by, which optional
						    layers are on (the librarian filters server-side, so a toggle
						    refetches), and the domain filter. */}
						<div className="flex flex-col gap-1.5 pb-1.5">
							<span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
								View
							</span>
							<label className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
								<span>Group by</span>
								<select
									aria-label="Group by"
									className="rounded-md border bg-background px-1.5 py-0.5 text-xs text-foreground"
									value={settings.groupBy}
									onChange={(e) => changeSettings((cur) => ({ ...cur, groupBy: e.target.value as GroupBy }))}
								>
									<option value="domain">Domain</option>
									<option value="section">Section</option>
								</select>
							</label>
							<label className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
								<span>Domain</span>
								<select
									aria-label="Domain filter"
									className="max-w-36 rounded-md border bg-background px-1.5 py-0.5 text-xs text-foreground"
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
							</label>
							{(
								[
									["archivedWork", "Archived work"],
									["denTopics", "Den topics"],
								] as const
							).map(([key, label]) => (
								<label key={key} className="flex cursor-pointer items-center justify-between text-[11px] text-muted-foreground">
									<span>{label}</span>
									<input
										type="checkbox"
										checked={settings.layers[key]}
										onChange={(e) =>
											changeSettings((cur) => ({ ...cur, layers: { ...cur.layers, [key]: e.target.checked } }))}
										className="accent-primary"
									/>
								</label>
							))}
						</div>
							{/* Size/zoom/region sliders: LADDER-mapped 0-100, step 10 (11
							    stops, every DEFAULT dead-center at 50, every value a nice
							    number — src/core/render-settings.ts). Physics keeps the
							    fine-grained log sliders (step 5). */}
							<SettingSlider
								label="Node size"
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(settings.nodeSize, NODE_SIZE_LADDER)}
								display={sizeDisplay(settings.nodeSize)}
								onChange={(p) =>
									changeSettings((cur) => ({ ...cur, nodeSize: fromLadderPosition(p, NODE_SIZE_LADDER) }))}
							/>
							<SettingSlider
								label="Edge width"
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(settings.edgeWidth, EDGE_WIDTH_LADDER)}
								display={sizeDisplay(settings.edgeWidth)}
								onChange={(p) =>
									changeSettings((cur) => ({ ...cur, edgeWidth: fromLadderPosition(p, EDGE_WIDTH_LADDER) }))}
							/>
							<SettingSlider
								label="Label size"
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(settings.labelSize, LABEL_SIZE_LADDER)}
								display={sizeDisplay(settings.labelSize)}
								onChange={(p) =>
									changeSettings((cur) => ({ ...cur, labelSize: fromLadderPosition(p, LABEL_SIZE_LADDER) }))}
							/>
							{/* Display is absolute (ratio / 0.5): "1×" is the default, dead-center (owner, 2026-10-07). */}
							<SettingSlider
								label="Labels until zoom"
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(settings.labelZoom, LABEL_ZOOM_LADDER)}
								display={labelZoomDisplay(settings.labelZoom)}
								onChange={(p) =>
									changeSettings((cur) => ({ ...cur, labelZoom: fromLadderPosition(p, LABEL_ZOOM_LADDER) }))}
							/>
							{/* Regions: the blurred cluster tints. Sliders + a fixed-set
						    dropdown for the bitmap resolution (it's a discrete
						    choice, not a free number). Server-persisted like the
						    sizes; every range end was sweep-validated on the real
						    graph. The enable switch is a COMPUTE switch: off skips
						    the whole build (splat/blur/readback/blit), not just
						    the paint. */}
						<div className="mt-1.5 flex flex-col gap-1.5 border-t pt-1.5">
							<span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
								Regions
							</span>
							<label className="flex cursor-pointer items-center justify-between text-[11px] text-muted-foreground">
								<span>Background colors</span>
								<input
									type="checkbox"
									checked={settings.regions.enabled}
									onChange={(e) =>
										changeSettings((cur) => ({
											...cur,
											regions: { ...cur.regions, enabled: e.target.checked },
										}))}
										className="accent-primary"
								/>
							</label>
							<SettingSlider
								label="Dilation"
								disabled={!regionTuning.enabled}
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(regionTuning.dilation, REGION_DILATION_LADDER)}
								display={sizeDisplay(regionTuning.dilation)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										regions: { ...cur.regions, dilation: fromLadderPosition(p, REGION_DILATION_LADDER) },
									}))}
							/>
							<SettingSlider
								label="Blur"
								disabled={!regionTuning.enabled}
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(regionTuning.blur, REGION_BLUR_LADDER)}
								display={sizeDisplay(regionTuning.blur)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										regions: { ...cur.regions, blur: fromLadderPosition(p, REGION_BLUR_LADDER) },
									}))
								}
							/>
							<SettingSlider
								label="Edge alpha"
								disabled={!regionTuning.enabled}
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(regionTuning.edgeAlpha, REGION_EDGE_ALPHA_LADDER)}
								display={sizeDisplay(regionTuning.edgeAlpha)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										regions: { ...cur.regions, edgeAlpha: fromLadderPosition(p, REGION_EDGE_ALPHA_LADDER) },
									}))}
							/>
							<label
								className={`flex items-center justify-between gap-2 text-[11px] text-muted-foreground${!regionTuning.enabled ? " opacity-40" : ""}`}
							>
								<span>Bitmap resolution</span>
								<select
									disabled={!regionTuning.enabled}
									className="rounded-md border bg-background px-1.5 py-0.5 text-xs tabular-nums text-foreground"
									value={regionTuning.bitmap}
									onChange={(e) =>
										changeSettings((cur) => ({
											...cur,
											regions: { ...cur.regions, bitmap: Number(e.target.value) },
										}))
									}
								>
									{REGION_BITMAP_OPTIONS.map((o) => (
										<option key={o} value={o}>
											{o}
										</option>
									))}
								</select>
							</label>
							{/* Cluster labels moved here 2026-09-16 (user: cluster
							    stuff lives in the regions section). Decoupled from
							    the Background colors switch above — labels follow
							    their own clusterLabels toggle. Size is screen px
							    (constant at any zoom, unlike node labels). */}
							<label className="flex cursor-pointer items-center justify-between text-[11px] text-muted-foreground">
								<span>Cluster labels</span>
								<input
									type="checkbox"
									checked={settings.clusterLabels}
									onChange={(e) => changeSettings((cur) => ({ ...cur, clusterLabels: e.target.checked }))}
									className="accent-primary"
								/>
							</label>
							<SettingSlider
								label="Cluster label size"
								disabled={!settings.clusterLabels}
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(settings.clusterLabelSize, CLUSTER_LABEL_SIZE_LADDER)}
								display={sizeDisplay(settings.clusterLabelSize)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										clusterLabelSize: fromLadderPosition(p, CLUSTER_LABEL_SIZE_LADDER),
									}))}
							/>
						</div>
						{/* Physics: the live sim's forces. Every value feeds the SAME
						    engine the server settle runs (createGraphSimulation);
						    changing one rebuilds the sim from the current positions —
						    drag mid-settle re-anneals, pins survive. Sliders over
						    sweep-validated ranges (src/core/render-settings.ts):
						    range ends and all four corners settle cleanly — no NaN,
						    no explosion, no non-settle. Repulsion is displayed as
						    the negative it is; cluster pull's far left = off.
						    Order (user 2026-09-17): general forces first; depth
						    anchor + its gray-out-able controls last. */}
						<div className="mt-1.5 flex flex-col gap-1.5 border-t pt-1.5">
							<span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
								Physics
							</span>
							<SettingSlider
								label="Node repulsion"
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(-physicsTuning.chargeStrength, -CHARGE_RANGE.max, -CHARGE_RANGE.min)}
								display={`-${Math.round(-physicsTuning.chargeStrength)}`}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, chargeStrength: -fromSliderPosition(p, -CHARGE_RANGE.max, -CHARGE_RANGE.min) },
									}))}
							/>
							<SettingSlider
								label="Edge attraction"
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.linkStrength, LINK_STRENGTH_RANGE.min, LINK_STRENGTH_RANGE.max)}
								display={sizeDisplay(physicsTuning.linkStrength)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, linkStrength: fromSliderPosition(p, LINK_STRENGTH_RANGE.min, LINK_STRENGTH_RANGE.max) },
									}))}
							/>
							<SettingSlider
								label="Edge length"
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.linkDistance, LINK_DISTANCE_RANGE.min, LINK_DISTANCE_RANGE.max)}
								display={sizeDisplay(physicsTuning.linkDistance)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, linkDistance: fromSliderPosition(p, LINK_DISTANCE_RANGE.min, LINK_DISTANCE_RANGE.max) },
									}))}
							/>
							<SettingSlider
								label="Central pull"
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.gravity, GRAVITY_RANGE.min, GRAVITY_RANGE.max)}
								display={sizeDisplay(physicsTuning.gravity)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, gravity: fromSliderPosition(p, GRAVITY_RANGE.min, GRAVITY_RANGE.max) },
									}))}
							/>
							<SettingSlider
								label="Cluster pull"
								min={0}
								max={100}
								step={5}
								value={toOffSliderPosition(physicsTuning.clusterPull, CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max)}
								display={physicsTuning.clusterPull <= 0 ? "off" : sizeDisplay(physicsTuning.clusterPull)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, clusterPull: fromOffSliderPosition(p, CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max) },
									}))}
							/>
							<SettingSlider
								label="Friction"
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.velocityDecay, VELOCITY_DECAY_RANGE.min, VELOCITY_DECAY_RANGE.max)}
								display={sizeDisplay(physicsTuning.velocityDecay)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, velocityDecay: fromSliderPosition(p, VELOCITY_DECAY_RANGE.min, VELOCITY_DECAY_RANGE.max) },
									}))}
							/>
							{/* Depth anchor LAST (user 2026-09-17): general
							    forces first, then the mode + its conditional
							    controls at the very bottom — the grayed group reads
							    as a self-contained sub-section. */}
							<label className="flex items-center justify-between gap-2 text-xs">
								Depth anchor (by hierarchy)
								<select
									className="rounded border bg-background px-1 py-0.5 text-xs"
									value={physicsTuning.depthMode}
									onChange={(e) =>
										changeSettings((cur) => ({
											...cur,
											physics: { ...cur.physics, depthMode: e.target.value as GraphRenderSettings["physics"]["depthMode"] },
										}))
									}
								>
									<option value="off">Off</option>
									<option value="vertical">Vertical (domains on top)</option>
									<option value="radial">Radial (domains at center)</option>
								</select>
							</label>
							<SettingSlider
								label="Depth strength"
								disabled={physicsTuning.depthMode === "off"}
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.depthStrength, DEPTH_STRENGTH_RANGE.min, DEPTH_STRENGTH_RANGE.max)}
								display={sizeDisplay(physicsTuning.depthStrength)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, depthStrength: fromSliderPosition(p, DEPTH_STRENGTH_RANGE.min, DEPTH_STRENGTH_RANGE.max) },
									}))}
							/>
							<SettingSlider
								label="Depth spacing"
								disabled={physicsTuning.depthMode === "off"}
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.depthSpacing, DEPTH_SPACING_RANGE.min, DEPTH_SPACING_RANGE.max)}
								display={sizeDisplay(physicsTuning.depthSpacing)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, depthSpacing: fromSliderPosition(p, DEPTH_SPACING_RANGE.min, DEPTH_SPACING_RANGE.max) },
									}))}
							/>
							<SettingSlider
								label="Base ring radius"
								disabled={physicsTuning.depthMode !== "radial"}
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.depthBaseRadius, DEPTH_BASE_RADIUS_RANGE.min, DEPTH_BASE_RADIUS_RANGE.max)}
								display={sizeDisplay(physicsTuning.depthBaseRadius)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, depthBaseRadius: fromSliderPosition(p, DEPTH_BASE_RADIUS_RANGE.min, DEPTH_BASE_RADIUS_RANGE.max) },
									}))}
							/>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

