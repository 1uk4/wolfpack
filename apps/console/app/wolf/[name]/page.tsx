import Link from "next/link";
import { notFound } from "next/navigation";
import { threadHref } from "@/src/core";
import { getConsoleClient, isNotFound } from "@/src/server";
import { SidebarToggle } from "@/components/sidebar";

export const dynamic = "force-dynamic";

/** One wolf's threads. */
export default async function WolfPage({ params }: { params: Promise<{ name: string }> }) {
	const { name } = await params;
	const threads = await getConsoleClient()
		.listThreads(name)
		.catch((err) => {
			if (isNotFound(err)) return null;
			throw err;
		});
	if (!threads) notFound();
	return (
		<div className="min-h-dvh">
			<header className="lh-drag lh-wco-gutter flex h-15 items-center gap-3 border-b border-border px-3">
				<SidebarToggle />
				<h1 className="font-title text-3xl tracking-tight">{name}</h1>
			</header>
			<ul className="mx-auto flex w-full max-w-2xl flex-col gap-1 px-6 py-6" data-testid="thread-list">
				{threads.map((t) => (
					<li key={t.id}>
						<Link href={threadHref(name, t.id)} className="block rounded-md px-2 py-1.5 text-sm hover:bg-accent">
							{t.title}
							<span className="ml-2 text-xs text-muted-foreground">{t.kind}</span>
						</Link>
					</li>
				))}
			</ul>
		</div>
	);
}
