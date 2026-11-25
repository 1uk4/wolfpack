"use client";

import { EntryReader } from "@/components/kb/entry-reader";
import type { ViewRendererProps } from "../registry";

/** Kind "kb": the KB entry body in the shell. Links to other entries or work items push onto the stack. */
export function KbEntryViewRenderer({ descriptor, onPush, onTitle }: ViewRendererProps) {
	return <EntryReader id={descriptor.id} chrome="none" onTitle={onTitle} onOpenView={onPush} />;
}
