/**
 * File tools for pi-durable wolves — read/write/append files in the wolf's den.
 *
 * Scoped to $WOLF_DEN for safety. Wolves can manage their own den data
 * (fitness logs, skill files, notes) without needing external tools.
 */
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

export function createFileToolsExtension(wolfDen: string) {
  function safePath(userPath: string): string {
    const resolved = resolve(wolfDen, userPath);
    const rel = relative(wolfDen, resolved);
    if (rel.startsWith("..") || resolve(resolved) !== resolved && !resolved.startsWith(wolfDen)) {
      throw new Error(`Path must be within $WOLF_DEN: ${userPath}`);
    }
    return resolved;
  }

  return defineExtension({
    name: "file-tools",
    tools: [
      defineTool({
        name: "read_file",
        description: "Read a file from the wolf's den. Path is relative to $WOLF_DEN.",
        parameters: {
          type: "object" as const,
          properties: {
            path: { type: "string" as const, description: "Path relative to $WOLF_DEN" },
          },
          required: ["path"],
        },
        async execute(args: { path: string }) {
          try {
            const p = safePath(args.path);
            const content = await readFile(p, "utf-8");
            return { content: [{ type: "text" as const, text: content }] };
          } catch (e: any) {
            return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
          }
        },
      }),

      defineTool({
        name: "write_file",
        description: "Write content to a file in the wolf's den. Creates parent directories. Path is relative to $WOLF_DEN.",
        parameters: {
          type: "object" as const,
          properties: {
            path: { type: "string" as const, description: "Path relative to $WOLF_DEN" },
            content: { type: "string" as const, description: "File content" },
          },
          required: ["path", "content"],
        },
        async execute(args: { path: string; content: string }) {
          try {
            const p = safePath(args.path);
            const dir = resolve(p, "..");
            await mkdir(dir, { recursive: true });
            await writeFile(p, args.content);
            return { content: [{ type: "text" as const, text: `Written: ${args.path}` }] };
          } catch (e: any) {
            return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
          }
        },
      }),

      defineTool({
        name: "append_file",
        description: "Append content to a file in the wolf's den. Creates the file if it doesn't exist. Path is relative to $WOLF_DEN.",
        parameters: {
          type: "object" as const,
          properties: {
            path: { type: "string" as const, description: "Path relative to $WOLF_DEN" },
            content: { type: "string" as const, description: "Content to append" },
          },
          required: ["path", "content"],
        },
        async execute(args: { path: string; content: string }) {
          try {
            const p = safePath(args.path);
            const dir = resolve(p, "..");
            await mkdir(dir, { recursive: true });
            await appendFile(p, args.content);
            return { content: [{ type: "text" as const, text: `Appended to: ${args.path}` }] };
          } catch (e: any) {
            return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
          }
        },
      }),

      defineTool({
        name: "list_files",
        description: "List files in a directory within the wolf's den. Path is relative to $WOLF_DEN.",
        parameters: {
          type: "object" as const,
          properties: {
            path: { type: "string" as const, description: "Directory path relative to $WOLF_DEN (default: root)" },
          },
          required: [],
        },
        async execute(args: { path?: string }) {
          try {
            const p = safePath(args.path ?? ".");
            const { readdir } = await import("node:fs/promises");
            const entries = await readdir(p, { withFileTypes: true });
            const lines = entries.map(e => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`);
            return { content: [{ type: "text" as const, text: lines.join("\n") || "(empty)" }] };
          } catch (e: any) {
            return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
          }
        },
      }),
    ],
  });
}
