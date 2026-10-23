#!/usr/bin/env node

// Early error catching
process.on("uncaughtException", (err) => {
  console.error("[harness] Uncaught exception:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[harness] Unhandled rejection:", reason);
  process.exit(1);
});

console.log("[harness] Loading modules...");

import * as readline from "node:readline";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { watchEvents } from "@earendil-works/pi-durable";
import { createWolfHarness } from "../index.js";

console.log("[harness] Modules loaded");

// Smoke mode: `wolfpack sync` runs the built bundle this way before uploading
// it. Every module above has loaded (a crash at load already happened); nothing
// is constructed, nothing connects.
if (process.argv.includes("--smoke") || process.env.WOLF_HARNESS_SMOKE === "1") {
  console.log("ok");
  process.exit(0);
}

async function main() {
  console.log("[harness] Starting main...");
  const instance = await createWolfHarness();
  console.log("[harness] Wolf harness created");
  const context = BACKGROUND_CONTEXT;

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down...`);
    await instance.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Interactive mode if TTY and no Telegram (avoid conflicting streams)
  if (process.stdin.isTTY && !instance.telegram) {
    console.log("\nInteractive mode (type a message, Ctrl+C to exit):\n");
    
    // Get root conversation
    const root = await instance.harness.root(context);
    
    // Watch events to stream responses
    const stream = await watchEvents(instance.harness, root.id, context);
    stream.start(async (events) => {
      for (const event of events) {
        if (event.type === "message_update") {
          for (const change of event.changes) {
            if (change.type === "text_delta") {
              process.stdout.write(change.delta);
            }
          }
        } else if (event.type === "message_end") {
          console.log("\n");
        }
      }
    });

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = () => rl.question("> ", async (input) => {
      const text = input.trim();
      if (!text) {
        prompt();
        return;
      }
      try {
        await root.submit({ type: "input", content: text }, context);
      } catch (err) {
        console.error("Error:", err);
      }
      prompt();
    });
    prompt();
  } else {
    // Daemon mode - keep alive for programmatic access
    // Use setInterval as a keep-alive mechanism (works with systemd)
    console.log("[harness] Running in daemon mode - keeping process alive");
    const keepAlive = setInterval(() => {
      console.log("[harness] Still running...");
    }, 60000); // Log every minute
    keepAlive.unref(); // Don't prevent exit if something else triggers it
    // Actually, we need to ref it to keep the process alive
    keepAlive.ref();
  }
  console.log("[harness] Main function completed");
}

main().catch((err) => {
  console.error("Harness failed to start:", err);
  process.exit(1);
});
