"use client";

/** The start page at "/": the Wolfpack mark, then one big button per wolf (the same /api/wolves roster the sidebar uses). */
import Link from "next/link";
import { useEffect, useState } from "react";
import { WolfpackMark } from "@/components/shell/wolfpack-mark";

export function WolfHomeView({ wolves }: { wolves: readonly { name: string }[] }) {
	return (
		<main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col items-center justify-center gap-8 px-6 py-10">
			<WolfpackMark className="size-24" />
			<nav aria-label="Wolves" className="flex w-full flex-col gap-3">
				{wolves.map((w) => (
					<Link
						key={w.name}
						href={`/wolf/${encodeURIComponent(w.name)}`}
						className="flex min-h-11 w-full items-center justify-center rounded-lg border px-4 py-3 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
					>
						{w.name}
					</Link>
				))}
			</nav>
		</main>
	);
}

export function WolfHome() {
	const [wolves, setWolves] = useState<{ name: string }[]>([]);
	useEffect(() => {
		let live = true;
		void fetch("/api/wolves", { cache: "no-store" })
			.then((r) => (r.ok ? r.json() : { wolves: [] }))
			.then((j: { wolves?: { name: string }[] }) => {
				if (live && Array.isArray(j.wolves)) setWolves(j.wolves.map((w) => ({ name: w.name })));
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);
	return <WolfHomeView wolves={wolves} />;
}
