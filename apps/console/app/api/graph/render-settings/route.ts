/**
 * GET/PUT /api/graph/render-settings — the graph view's display settings, per person on the hub (pref `graph.render-settings`)
 * with the old server-global file (data/graph/render-settings.json) as the fallback and the one-time migration source.
 * See src/server/kb/render-settings-api.ts for the rules.
 *
 *   GET → 200 the settings, or 200 null when nothing is saved anywhere (the client keeps in-memory defaults).
 *   PUT → 200 the sanitized settings actually stored.
 */
import { createRenderSettingsApi, readRenderSettings, writeRenderSettings } from "@/src/server";

export const dynamic = "force-dynamic";

const api = createRenderSettingsApi({ readLocal: readRenderSettings, writeLocal: writeRenderSettings });

export const GET = (req: Request) => api.get(req);
export const PUT = (req: Request) => api.put(req);
