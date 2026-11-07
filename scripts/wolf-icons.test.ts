import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs
import { ROOT, TARGETS, markSvg } from "./wolf-icons.mjs";

type Target = { out: string; size: number; scale: number };
const dOf = (file: string, re: RegExp) => re.exec(readFileSync(join(ROOT, file), "utf8"))![1];

describe("wolf icons", () => {
  it("keeps the maskable mark inside the 80% safe circle", () => {
    // Farthest path vertex from the box centre (32,32), read from the path itself (absolute M/L/H/V/Z commands).
    const d = dOf("brand/wolf-head.svg", /<path d="([^"]+)"/);
    let x = 0, y = 0, far = 0;
    for (const [, cmd, args] of d.matchAll(/([MLHVZ])([^MLHVZ]*)/g)) {
      const n = args.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      if (cmd === "H") x = n[0];
      else if (cmd === "V") y = n[0];
      else if (cmd !== "Z") [x, y] = n;
      far = Math.max(far, Math.hypot(x - 32, y - 32));
    }
    const t = (TARGETS as Target[]).find((t) => t.out.endsWith("icon-maskable-512.png"))!;
    expect((far * t.scale * t.size) / 64).toBeLessThanOrEqual(0.4 * t.size);
  });

  it("paints the head path evenodd", () => {
    expect(markSvg({ size: 100, scale: 0.5 })).toContain('fill-rule="evenodd"');
  });

  it("keeps the sidebar mark's path identical to brand/wolf-head.svg", () => {
    const brand = dOf("brand/wolf-head.svg", /<path d="([^"]+)"/);
    const tsx = dOf("apps/console/components/wolfpack-mark.tsx", /\bd="([^"]+)"/);
    expect(tsx).toBe(brand);
  });
});
