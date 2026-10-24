import Link from "next/link";
import { threadHref } from "@/src/core";
import { getConsoleClient } from "@/src/server";
import { SidebarToggle } from "@/components/sidebar";

// Dynamic: the wolf list is live client state, never a build-time snapshot.
export const dynamic = "force-dynamic";

/**
 * Home placeholder: the wolves the ConsoleClient knows, each with its
 * threads. The graph view (components/graph-view.tsx) stays unrouted.
 */
export default async function HomePage() {
	const client = getConsoleClient();
	const wolves = await client.listWolves();
	const entries = await Promise.all(
		wolves.map(async (wolf) => ({ wolf, threads: await client.listThreads(wolf.name) })),
	);
	return (
		<div className="relative min-h-dvh">
			<header className="lh-drag lh-wco-gutter flex h-15 items-center gap-3 px-3">
				<SidebarToggle />
			</header>
			<div className="mx-auto w-full max-w-2xl px-6 py-10">
				<h1 className="font-title text-4xl tracking-tight">Wolfpack Console</h1>
				<p className="mt-2 text-sm text-muted-foreground">The control plane for wolfpack agents.</p>
				<ul className="mt-8 flex flex-col gap-6" data-testid="wolf-list">
					{entries.map(({ wolf, threads }) => (
						<li key={wolf.id} data-testid="wolf" className="rounded-xl border bg-card p-4">
							<div className="flex items-baseline gap-3">
								<Link href={`/wolf/${encodeURIComponent(wolf.name)}`} className="font-title text-2xl hover:underline">
									{wolf.name}
								</Link>
								<span className="text-xs uppercase tracking-wide text-muted-foreground">
									{wolf.host} · {wolf.status}
								</span>
							</div>
							<ul className="mt-3 flex flex-col gap-1">
								{threads.map((t) => (
									<li key={t.id}>
										<Link
											href={threadHref(wolf.name, t.id)}
											className="block rounded-md px-2 py-1.5 text-sm hover:bg-accent"
										>
											{t.title}
											<span className="ml-2 text-xs text-muted-foreground">{t.kind}</span>
										</Link>
									</li>
								))}
							</ul>
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}
