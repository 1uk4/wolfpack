"use client";

/**
 * THE ONE PLACE A PACK SECTION PLUGS IN (work-wolfpack-bq9iYp3). Replace a placeholder with the real body:
 *   keys work-wolfpack-6EmU8pu, machines work-wolfpack-4qae7Hg, devices work-wolfpack-Rqmr32h, wolves work-wolfpack-eE5FKDy,
 *   this-device work-wolfpack-5lSw5c1.
 * The Record is keyed by PackSectionId (src/core/pack/pack-sections.ts), so a section without a body fails the typecheck.
 * Its badge is the `badge` hook on the section's entry in PACK_SECTIONS.
 * Choice made by the shell: sections whose task is not built yet show a placeholder. Machines keeps the existing health cards
 * (that is how the pack's health stays reachable) and Domains mounts today's Domains UI unchanged.
 */
import type { ComponentType } from "react";
import { MachinesBody } from "@/components/pack/pack-health";
import { DevicesBody } from "@/components/pack/pack-devices";
import { DomainsTab } from "@/components/pack/pack-domains";
import type { PackSectionId } from "@/src/core";

function Placeholder({ id, title, task }: { id: PackSectionId; title: string; task: string }) {
	return (
		<div data-testid={`pack-placeholder-${id}`} className="rounded-md border border-dashed px-4 py-6 text-muted-foreground">
			<p className="text-foreground">{title}</p>
			<p className="mt-1">This section is being built ({task}).</p>
		</div>
	);
}

export const PACK_SECTION_BODIES: Record<PackSectionId, ComponentType> = {
	machines: MachinesBody,
	devices: DevicesBody,
	wolves: () => <Placeholder id="wolves" title="Wolves" task="work-wolfpack-eE5FKDy" />,
	domains: DomainsTab,
	keys: () => <Placeholder id="keys" title="Keys" task="work-wolfpack-6EmU8pu" />,
	"this-device": () => <Placeholder id="this-device" title="This device" task="work-wolfpack-5lSw5c1" />,
};
