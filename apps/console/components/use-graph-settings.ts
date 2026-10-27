"use client";

/**
 * The graph's render settings: SERVER-persisted (data/graph/render-settings.json
 * via /api/graph/render-settings) — sizes, the view choices (group by, layers,
 * domain filter) and the region/physics sections. Loaded once after mount;
 * every user change saves back, debounced. Defaults render until the load
 * resolves (`loaded` says when), and a change made before the load settles is
 * held back and wins over the server copy.
 */
import { useEffect, useRef, useState } from "react";
import { DEFAULT_RENDER_SETTINGS, sanitizeRenderSettings, type GraphRenderSettings } from "@/src/core";

export interface GraphSettingsState {
	settings: GraphRenderSettings;
	loaded: boolean;
	changeSettings: (update: (cur: GraphRenderSettings) => GraphRenderSettings) => void;
}

function saveToServer(s: GraphRenderSettings): void {
	fetch("/api/graph/render-settings", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(s),
	}).catch((err) => console.error("[graph] settings save failed:", err));
}

export function useGraphSettings(): GraphSettingsState {
	const [settings, setSettings] = useState<GraphRenderSettings>(DEFAULT_RENDER_SETTINGS);
	const [loaded, setLoaded] = useState(false);
	const settingsRef = useRef(settings);
	settingsRef.current = settings;
	// True once the user has moved a control this mount: the server copy
	// must never clobber a (possibly newer) local change.
	const userTouched = useRef(false);
	// True once the initial GET settled — saves are held back until then,
	// so merely mounting never PUTs defaults over the server copy.
	const serverLoaded = useRef(false);
	const savePending = useRef(false);

	const changeSettings = (update: (cur: GraphRenderSettings) => GraphRenderSettings) => {
		userTouched.current = true;
		setSettings(update);
	};

	useEffect(() => {
		fetch("/api/graph/render-settings")
			.then((res) => (res.ok ? (res.json() as Promise<unknown>) : null))
			.then((raw) => {
				if (raw !== null && !userTouched.current) setSettings(sanitizeRenderSettings(raw));
			})
			.catch(() => {
				// server unreachable → in-memory defaults keep working
			})
			.finally(() => {
				serverLoaded.current = true;
				setLoaded(true);
				if (savePending.current) {
					savePending.current = false;
					saveToServer(settingsRef.current);
				}
			});
	}, []);

	useEffect(() => {
		if (!userTouched.current) return; // mount-run / server-apply: no save
		if (!serverLoaded.current) {
			savePending.current = true; // hold until the GET settles
			return;
		}
		const id = setTimeout(() => saveToServer(settings), 400);
		return () => clearTimeout(id);
	}, [settings]);

	return { settings, loaded, changeSettings };
}
