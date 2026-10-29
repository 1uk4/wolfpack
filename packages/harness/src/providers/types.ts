import type { Provider } from "@earendil-works/pi-ai/models";

/** What a provider factory is handed. Test seams ride in `seams`, keyed by provider id. */
export interface ProviderContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  seams?: Record<string, unknown>;
}

/** A built provider plus its optional lifecycle hooks. */
export interface ProviderHandle {
  provider: Provider;
  /** Free what the provider holds for one conversation (its provider session id), e.g. a parked child process. */
  forget?(sessionId: string): void;
  /** Release everything the provider holds. Called once, on shutdown. */
  dispose?(): void;
}

export type ProviderFactory = (ctx: ProviderContext) => ProviderHandle;
