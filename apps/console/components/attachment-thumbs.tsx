import type { AttachmentInfo } from "@/components/attachments";

/** The thumbnails of a user bubble's attachments: each links to the full image (same-origin console route). */
export function AttachmentThumbs({ items, urlFor }: { items: readonly AttachmentInfo[]; urlFor?: (id: string) => string }) {
	if (items.length === 0 || !urlFor) return null;
	return (
		<div data-testid="attachment-thumbs" className="mt-1.5 flex flex-wrap gap-2">
			{items.map((a) => (
				<a key={a.id} href={urlFor(a.id)} target="_blank" rel="noreferrer" title={a.name} className="block overflow-hidden rounded-md border">
					{/* eslint-disable-next-line @next/next/no-img-element -- a proxied user upload; next/image would re-encode it */}
					<img data-testid="attachment-thumb" src={urlFor(a.id)} alt={a.name ?? "attached image"} loading="lazy" className="max-h-40 max-w-56 object-cover" />
				</a>
			))}
		</div>
	);
}
