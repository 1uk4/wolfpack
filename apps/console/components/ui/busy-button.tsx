"use client";

import * as React from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * A Button for submit-style actions: while `busy` it is disabled, aria-busy and shows a spinner before its label.
 * Pair with useBusyAction (./use-busy-action): `const { run, busy } = useBusyAction(save); <BusyButton busy={busy} onClick={run}>Save</BusyButton>`.
 */
export function BusyButton({ busy, children, disabled, ...props }: React.ComponentProps<typeof Button> & { busy: boolean }) {
	return (
		<Button {...props} disabled={disabled || busy} aria-busy={busy || undefined}>
			{busy && <Loader2Icon className="animate-spin" />}
			{children}
		</Button>
	);
}
