"use client";

/**
 * Keeps the live layer and the activity feed from taking the graph page down: an error inside renders nothing (logged once)
 * and the graph underneath keeps working.
 */
import { Component, type ReactNode } from "react";

export class LiveErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	componentDidCatch(error: unknown): void {
		console.error("live graph layer disabled after an error", error);
	}

	render(): ReactNode {
		return this.state.failed ? null : this.props.children;
	}
}
