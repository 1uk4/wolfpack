/**
 * file-observation.ts — Track files affected during work sessions
 * 
 * Observes what files were touched while working on a task.
 * Used to generate tight summaries of what was completed.
 */

// ════════════════════════════════════════════════════════════════════════════
// 1 · FILE CHANGE TRACKING
// ════════════════════════════════════════════════════════════════════════════

export interface FileChange {
  path: string;
  action: "created" | "modified" | "deleted";
  at: string;
  /** Brief description of what changed (optional, from context) */
  summary?: string;
}

export interface WorkFileSession {
  workId: string;
  startedAt: string;
  files: FileChange[];
}

/** Active file tracking sessions by work item id */
const fileSessions = new Map<string, WorkFileSession>();

/**
 * Start tracking files for a work item
 */
export function startFileTracking(workId: string): void {
  fileSessions.set(workId, {
    workId,
    startedAt: new Date().toISOString(),
    files: [],
  });
}

/**
 * Stop tracking files for a work item and return the session
 */
export function stopFileTracking(workId: string): WorkFileSession | null {
  const session = fileSessions.get(workId);
  fileSessions.delete(workId);
  return session || null;
}

/**
 * Record a file change for the active work item
 */
export function recordFileChange(
  workId: string,
  path: string,
  action: FileChange["action"],
  summary?: string
): void {
  const session = fileSessions.get(workId);
  if (!session) return;

  // Dedupe: if same file already tracked, update it
  const existing = session.files.find(f => f.path === path);
  if (existing) {
    existing.action = action;
    existing.at = new Date().toISOString();
    if (summary) existing.summary = summary;
  } else {
    session.files.push({
      path,
      action,
      at: new Date().toISOString(),
      summary,
    });
  }
}

/**
 * Get the current file session for a work item
 */
export function getFileSession(workId: string): WorkFileSession | null {
  return fileSessions.get(workId) || null;
}

// ════════════════════════════════════════════════════════════════════════════
// 2 · FILE CHANGE SUMMARY
// ════════════════════════════════════════════════════════════════════════════

/**
 * Summarize file changes for inclusion in task completion summary
 */
export function summarizeFileChanges(session: WorkFileSession): string {
  const files = session?.files ?? [];
  if (files.length === 0) {
    return "No files tracked during this session.";
  }

  const created = files.filter(f => f.action === "created");
  const modified = files.filter(f => f.action === "modified");
  const deleted = files.filter(f => f.action === "deleted");

  const parts: string[] = [];

  if (created.length > 0) {
    parts.push(`Created: ${created.map(f => f.path).join(", ")}`);
  }
  if (modified.length > 0) {
    parts.push(`Modified: ${modified.map(f => f.path).join(", ")}`);
  }
  if (deleted.length > 0) {
    parts.push(`Deleted: ${deleted.map(f => f.path).join(", ")}`);
  }

  return parts.join("\n");
}

/**
 * Group files by directory for cleaner output
 */
export function groupFilesByDirectory(session: WorkFileSession): Map<string, FileChange[]> {
  const groups = new Map<string, FileChange[]>();

  for (const file of session.files) {
    const dir = file.path.split("/").slice(0, -1).join("/") || ".";
    const existing = groups.get(dir) || [];
    existing.push(file);
    groups.set(dir, existing);
  }

  return groups;
}

// ════════════════════════════════════════════════════════════════════════════
// 3 · PATTERN DETECTION (for future automation)
// ════════════════════════════════════════════════════════════════════════════

export interface WorkPattern {
  /** Type of pattern detected */
  type: "schema-change" | "api-endpoint" | "ui-component" | "test" | "config" | "refactor";
  /** Files involved in this pattern */
  files: string[];
  /** Brief description */
  description: string;
}

/**
 * Detect common work patterns from file changes
 * Used to identify automation opportunities
 */
export function detectPatterns(session: WorkFileSession): WorkPattern[] {
  const patterns: WorkPattern[] = [];
  const files = session.files.map(f => f.path);

  // Schema changes often involve schema file + types + tests
  const schemaFiles = files.filter(f => 
    f.includes("schema") || f.includes("types") || f.endsWith(".schema.ts")
  );
  if (schemaFiles.length > 0) {
    patterns.push({
      type: "schema-change",
      files: schemaFiles,
      description: "Schema/type definition changes",
    });
  }

  // API endpoints: route + handler + test
  const apiFiles = files.filter(f => 
    f.includes("api") || f.includes("route") || f.includes("endpoint")
  );
  if (apiFiles.length > 0) {
    patterns.push({
      type: "api-endpoint",
      files: apiFiles,
      description: "API endpoint work",
    });
  }

  // UI components
  const uiFiles = files.filter(f => 
    f.endsWith(".tsx") || f.endsWith(".vue") || f.endsWith(".svelte") ||
    f.includes("component") || f.includes("pages")
  );
  if (uiFiles.length > 0) {
    patterns.push({
      type: "ui-component",
      files: uiFiles,
      description: "UI component work",
    });
  }

  // Tests
  const testFiles = files.filter(f => 
    f.includes(".test.") || f.includes(".spec.") || f.includes("__tests__")
  );
  if (testFiles.length > 0) {
    patterns.push({
      type: "test",
      files: testFiles,
      description: "Test additions/modifications",
    });
  }

  // Config changes
  const configFiles = files.filter(f => 
    f.includes("config") || f.endsWith(".json") || f.endsWith(".yaml") ||
    f.endsWith(".yml") || f.includes("env")
  );
  if (configFiles.length > 0) {
    patterns.push({
      type: "config",
      files: configFiles,
      description: "Configuration changes",
    });
  }

  return patterns;
}
