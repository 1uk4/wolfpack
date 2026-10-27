export type Isolation = "worktree" | "none";

export interface IsolationProfile {
  tools?: readonly string[];
  isolation?: Isolation;
}

const WRITE_TOOLS = new Set(["edit", "write", "bash"]);

/** A writer has edit, write or bash. An absent tools list means the default toolset, which can write. */
export function isWriter(tools: readonly string[] | undefined): boolean {
  if (tools === undefined) return true;
  return tools.some((t) => WRITE_TOOLS.has(t.toLowerCase()));
}

export function defaultIsolation(profile: IsolationProfile, cwdIsGit: boolean): Isolation {
  return profile.isolation ?? (isWriter(profile.tools) && cwdIsGit ? "worktree" : "none");
}
