/** What the proxy needs to know about the wolves behind it. The supervisor implements it; tests inject a static one. */
export interface WolfEntry {
  name: string;
  id: string;
  host: string;
}

export interface WolfRegistry {
  wolves(): WolfEntry[];
  /** Base URL of the wolf's /v1 server, or undefined when unknown or not currently online. */
  upstream(name: string): string | undefined;
  has(name: string): boolean;
}

/** Fixed name → url map (tests, embedding). */
export function staticRegistry(map: Record<string, string>, host = "local"): WolfRegistry {
  return {
    wolves: () => Object.keys(map).map((name) => ({ name, id: name, host })),
    upstream: (name) => map[name],
    has: (name) => name in map,
  };
}
