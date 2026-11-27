"use client";

/**
 * The "Groups" section of the graph settings (work-wolfpack-FnzgC6g): create a group (name, optional colour and icon), add or remove
 * domains, rename or delete it. Visual only: it never changes a domain. A domain lives in at most one group, so adding it here moves
 * it. Lucide icons, icon-only buttons with a tooltip and an aria-label, 44px touch targets below md.
 */
import { useState } from "react";
import { Briefcase, Building2, ChevronRight, Folder, Layers, Plus, Star, Trash2, X, type LucideIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import {
	addDomainToGroup,
	createGroup,
	deleteGroup,
	removeDomainFromGroup,
	renameGroup,
	updateGroup,
	type GraphGroups,
	type KbGraphDomain,
} from "@/src/core";

/** The icons a group can carry (stored by name). */
export const GROUP_ICONS: Record<string, LucideIcon> = { layers: Layers, briefcase: Briefcase, building: Building2, folder: Folder, star: Star };

const BTN = "flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground md:size-7";
const FIELD = "min-h-11 rounded-md border bg-background px-1.5 text-xs text-foreground md:min-h-7";

function newId(): string {
	return `g${Math.random().toString(36).slice(2, 8)}`;
}

export function GroupsEditor({
	groups,
	changeGroups,
	domains,
}: {
	groups: GraphGroups;
	changeGroups: (update: (cur: GraphGroups) => GraphGroups) => void;
	domains: readonly KbGraphDomain[];
}) {
	const [name, setName] = useState("");
	const label = (d: string) => domains.find((x) => x.name === d)?.label ?? d;
	return (
		<details className="group rounded-[10px] border border-border/60 bg-background/40 px-2">
			<summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-[11px] font-medium text-muted-foreground md:min-h-7 [&::-webkit-details-marker]:hidden">
				<ChevronRight className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
				Groups
			</summary>
			<div className="flex flex-col gap-2 pb-2 pt-1">
				{groups.groups.map((g) => {
					const Icon = g.icon ? GROUP_ICONS[g.icon] : undefined;
					const free = domains.filter((d) => !g.domains.includes(d.name));
					return (
						<div key={g.id} className="flex flex-col gap-1.5 rounded-lg border border-border/50 p-1.5">
							<div className="flex items-center gap-1">
								{Icon && <Icon className="size-4 shrink-0" style={{ color: g.color ?? undefined }} aria-hidden />}
								<input
									aria-label={`Group name, ${g.name}`}
									defaultValue={g.name}
									maxLength={40}
									className={`${FIELD} min-w-0 flex-1`}
									onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== g.name && changeGroups((c) => renameGroup(c, g.id, e.target.value))}
									onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
								/>
								<input
									type="color"
									aria-label={`Colour of ${g.name}`}
									value={g.color ?? "#6b7280"}
									className="size-11 shrink-0 cursor-pointer rounded-md border bg-background p-0.5 md:size-7"
									onChange={(e) => changeGroups((c) => updateGroup(c, g.id, { color: e.target.value }))}
								/>
								<select
									aria-label={`Icon of ${g.name}`}
									className={FIELD}
									value={g.icon ?? ""}
									onChange={(e) => changeGroups((c) => updateGroup(c, g.id, { icon: e.target.value || null }))}
								>
									<option value="">No icon</option>
									{Object.keys(GROUP_ICONS).map((k) => (
										<option key={k} value={k}>
											{k}
										</option>
									))}
								</select>
								<Hint label="Delete group" side="bottom">
									<button type="button" aria-label={`Delete group ${g.name}`} className={BTN} onClick={() => changeGroups((c) => deleteGroup(c, g.id))}>
										<Trash2 className="size-3.5" />
									</button>
								</Hint>
							</div>
							<div className="flex flex-wrap items-center gap-1">
								{g.domains.map((d) => (
									<span key={d} className="flex items-center gap-0.5 rounded-full bg-muted/70 pl-2 text-[11px] text-foreground">
										{label(d)}
										<button
											type="button"
											aria-label={`Remove ${label(d)} from ${g.name}`}
											className="flex size-11 items-center justify-center rounded-full text-muted-foreground hover:text-foreground md:size-6"
											onClick={() => changeGroups((c) => removeDomainFromGroup(c, g.id, d))}
										>
											<X className="size-3" />
										</button>
									</span>
								))}
								{free.length > 0 && (
									<select
										aria-label={`Add a domain to ${g.name}`}
										className={FIELD}
										value=""
										onChange={(e) => e.target.value && changeGroups((c) => addDomainToGroup(c, g.id, e.target.value))}
									>
										<option value="">Add domain…</option>
										{free.map((d) => (
											<option key={d.name} value={d.name}>
												{d.label}
											</option>
										))}
									</select>
								)}
							</div>
						</div>
					);
				})}
				<form
					className="flex items-center gap-1"
					onSubmit={(e) => {
						e.preventDefault();
						if (!name.trim()) return;
						changeGroups((c) => createGroup(c, newId(), { name }));
						setName("");
					}}
				>
					<input aria-label="New group name" placeholder="New group" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} className={`${FIELD} min-w-0 flex-1`} />
					<Hint label="Create group" side="bottom">
						<button type="submit" aria-label="Create group" className={BTN}>
							<Plus className="size-4" />
						</button>
					</Hint>
				</form>
				<p className="text-[10px] text-muted-foreground">Groups only draw a bubble around domains. Nothing else changes.</p>
			</div>
		</details>
	);
}
