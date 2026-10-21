/**
 * Extension lifecycle runner.
 *
 * Starts each extension's `lifecycle.start` in load order and returns a
 * `stop` that runs the matching `lifecycle.stop` hooks in reverse. A failing
 * hook is logged and never blocks the others.
 */
import type { LifecycleContext, TelegramSharedState } from "./extension-api.js";
import type { LoadedLifecycle } from "./loader.js";

export interface LifecycleBase {
  wolfDen: string;
  wolfName: string;
  telegram?: TelegramSharedState;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Send to the owner's chat through the shared bot API, if there is one. */
function makeSend(telegram: TelegramSharedState | undefined): LifecycleContext["send"] {
  return async (text) => {
    const api = telegram?.botApi;
    const chatId = api?.getChatId();
    if (!api || !chatId) return false;
    await api.sendMessage(chatId, text);
    return true;
  };
}

export async function startLifecycles(
  loaded: LoadedLifecycle[],
  base: LifecycleBase,
): Promise<() => Promise<void>> {
  const started: LoadedLifecycle[] = [];

  for (const entry of loaded) {
    started.push(entry); // stop still runs if start fails midway
    try {
      await entry.lifecycle.start?.({
        wolfDen: base.wolfDen,
        wolfName: base.wolfName,
        config: entry.config,
        telegram: base.telegram,
        send: makeSend(base.telegram),
      });
      console.log(`[harness] Extension ${entry.name} started`);
    } catch (err) {
      console.warn(`[harness] Extension ${entry.name} failed to start: ${message(err)}`);
    }
  }

  return async () => {
    for (const entry of [...started].reverse()) {
      try {
        await entry.lifecycle.stop?.();
      } catch (err) {
        console.warn(`[harness] Extension ${entry.name} failed to stop: ${message(err)}`);
      }
    }
  };
}
