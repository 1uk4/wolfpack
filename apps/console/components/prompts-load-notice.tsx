/** Above the Prompts graph: a loading line while the list is pending, or the error with a Retry button. Nothing when neither applies. */
export function PromptsLoadNotice({ loading, error, onRetry }: { loading: boolean; error: string; onRetry: () => void }) {
	if (error) {
		return (
			<div className="flex flex-wrap items-center gap-2 text-sm text-destructive" data-testid="prompts-load-error">
				<p role="alert">{error}</p>
				<button className="rounded border px-3 py-1 text-sm text-foreground" onClick={onRetry} data-testid="prompts-retry">Retry</button>
			</div>
		);
	}
	return loading ? <p className="text-sm text-muted-foreground" data-testid="prompts-loading">Loading prompts…</p> : null;
}
