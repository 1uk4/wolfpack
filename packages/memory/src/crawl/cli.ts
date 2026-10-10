/**
 * cli — command-line front end for the crawl pipeline (dev + automation).
 *   plan   → plan.ts    (deterministic: discover, dates, group; no LLM)
 *   run    → run.ts     (gate, extract → consolidate per batch, journey)
 *   resume → resume.ts  (re-run LLM stages from a prior run's artifacts)
 *   emit   → emit.ts    (release staged topics to the KB inbox)
 */
import { planCrawl, writePlan } from "./plan.js";
import { runCrawl } from "./run.js";
import { resumeCrawl } from "./resume.js";
import type { Strategy } from "./schemas.js";

// ── direct invocation ─────────────────────────────────────────────────────────
//   crawl plan <source> <domain> [strategy] [--depth N] [--ready] [--out FILE]
//   crawl run  <plan.yaml> [--limit N]
const USAGE = [
  "usage:",
  "  crawl plan   <source> <domain> [by-folder|by-pattern] [--depth N] [--ready] [--out FILE]",
  "  crawl run    <plan.yaml> [--limit N] [--concurrency N]",
  "  crawl resume <run-dir> [--from observations|topics]   # reuse saved artifacts",
  "  crawl emit   <run-dir> [--dry-run]                    # release staged topics to inbox",
].join("\n");

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].endsWith("crawl/cli.js");

if (isMain) {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };

  if (cmd === "plan") {
    const positional = rest.filter((a) => !a.startsWith("--"));
    const [source, domain, strategy = "by-folder"] = positional;
    if (!source || !domain) {
      console.error(USAGE);
      process.exit(1);
    }
    const depth = flag("--depth");
    const { plan, sink } = planCrawl({
      source,
      domain,
      strategy: strategy as Strategy,
      folderDepth: depth ? Number(depth) : undefined,
    });
    const ready = rest.includes("--ready");
    const finalPlan = ready ? { ...plan, status: "ready" as const } : plan;
    const out = flag("--out");
    if (out || ready) {
      const target = out ?? `${sink.dir}/plan.yaml`;
      writePlan(target, finalPlan);
      console.log(`Plan written: ${target} (status: ${finalPlan.status})`);
    }
    console.log(
      `\nReview the plan, set 'status: ready', then:\n  crawl run ${out ?? sink.dir + "/plan.yaml"}\n\nOutput: ${sink.dir}`
    );
  } else if (cmd === "run") {
    const planPath = rest.find((a) => !a.startsWith("--"));
    if (!planPath) {
      console.error(USAGE);
      process.exit(1);
    }
    const lim = flag("--limit");
    const conc = flag("--concurrency");
    runCrawl(planPath, {
      limit: lim ? Number(lim) : undefined,
      concurrency: conc ? Number(conc) : undefined,
    })
      .then((r) => {
        if (!r.ok) {
          console.error(
            `\nRun refused. Fix the plan and set status: ready.\n  ` +
              (r.failures ?? []).join("\n  ") +
              `\n\nLog: ${r.dir}`
          );
          process.exit(2);
        }
        console.log(`\nOutput: ${r.dir}`);
      })
      .catch((e) => {
        console.error(e);
        process.exit(1);
      });
  } else if (cmd === "resume") {
    const runDir = rest.find((a) => !a.startsWith("--"));
    if (!runDir) {
      console.error(USAGE);
      process.exit(1);
    }
    const fromRaw = flag("--from");
    const fromOpt = fromRaw === "topics" ? "topics" : "observations";
    resumeCrawl(runDir, { from: fromOpt })
      .then((r) => console.log(`\nOutput: ${r.dir}`))
      .catch((e) => {
        console.error(e);
        process.exit(1);
      });
  } else if (cmd === "emit") {
    const runDir = rest.find((a) => !a.startsWith("--"));
    if (!runDir) {
      console.error(USAGE);
      process.exit(1);
    }
    import("./emit.js").then(({ emitCrawl }) =>
      emitCrawl(runDir, { dryRun: rest.includes("--dry-run") })
    );
  } else {
    console.error(USAGE);
    process.exit(1);
  }
}
