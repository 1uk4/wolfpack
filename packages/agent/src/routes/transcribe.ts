/**
 * Transcribe audio to text via whisper.cpp.
 *
 * POST /transcribe
 *   headers: X-API-Key (same auth as the rest of the agent)
 *   body:    raw audio bytes (any format ffmpeg can decode: ogg, opus, m4a,
 *            mp3, wav, webm). Content-Type is ignored.
 *   returns: { text, language, durationMs, inputBytes, model }
 *
 * Pipeline: input bytes → ffmpeg → mono 16kHz WAV → whisper.cpp → JSON.
 *
 * Config (all have sensible defaults for the sfo-01 install path):
 *   WHISPER_BIN       — whisper.cpp CLI (default /opt/whisper-cpp/build/bin/whisper-cli)
 *   WHISPER_MODEL     — ggml model path (default .../models/ggml-large-v3-turbo.bin)
 *   WHISPER_LANGUAGE  — "auto" (default) | ISO code (e.g. "en") to force language
 *   WHISPER_THREADS   — worker threads (default 4)
 *   FFMPEG_BIN        — ffmpeg binary (default "ffmpeg" on PATH)
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { spawn } from "node:child_process";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const WHISPER_BIN = process.env.WHISPER_BIN ?? "/opt/whisper-cpp/build/bin/whisper-cli";
const WHISPER_MODEL = process.env.WHISPER_MODEL ?? "/opt/whisper-cpp/models/ggml-large-v3-turbo.bin";
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE ?? "auto";
const WHISPER_THREADS = Number(process.env.WHISPER_THREADS ?? "4");
const FFMPEG_BIN = process.env.FFMPEG_BIN ?? "ffmpeg";
const MAX_BYTES = 50 * 1024 * 1024; // 50MB — enough for 30+ min of voice at opus bitrates

/**
 * Spawn a child process and resolve with its stdout, or reject with stderr.
 * Writes `input` to stdin if provided, otherwise closes stdin.
 */
function run(
  cmd: string,
  args: string[],
  input?: Buffer,
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const outChunks: Buffer[] = [];
    let errBuf = "";
    child.stdout.on("data", (c) => outChunks.push(c as Buffer));
    child.stderr.on("data", (c) => (errBuf += (c as Buffer).toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(outChunks), stderr: errBuf });
      else reject(new Error(`${cmd} exited ${code}: ${errBuf.slice(0, 400)}`));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

export function transcribeRouter(): Router {
  const router = Router();

  // Raw body parser — audio comes in as bytes, not JSON.
  // We register it per-route so it doesn't fight the global JSON parser.
  router.post(
    "/",
    (req, res, next) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on("data", (c: Buffer) => {
        total += c.length;
        if (total > MAX_BYTES) {
          res.status(413).json({ error: `audio exceeds ${MAX_BYTES} bytes` });
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        (req as Request & { rawAudio: Buffer }).rawAudio = Buffer.concat(chunks);
        next();
      });
      req.on("error", (err) => next(err));
    },
    async (req: Request & { rawAudio?: Buffer }, res: Response) => {
      const audio = req.rawAudio;
      if (!audio || audio.length === 0) {
        res.status(400).json({ error: "empty audio body" });
        return;
      }
      if (!existsSync(WHISPER_BIN)) {
        res.status(503).json({ error: `whisper binary not found at ${WHISPER_BIN}` });
        return;
      }
      if (!existsSync(WHISPER_MODEL)) {
        res.status(503).json({ error: `whisper model not found at ${WHISPER_MODEL}` });
        return;
      }

      // Scratch dir per request so parallel transcribes don't collide.
      const id = randomBytes(6).toString("hex");
      const scratch = join(tmpdir(), `transcribe-${id}`);
      await mkdir(scratch, { recursive: true });
      const wavPath = join(scratch, "input.wav");

      try {
        const started = Date.now();

        // Decode whatever the client sent → mono 16kHz PCM WAV (what whisper wants).
        await run(
          FFMPEG_BIN,
          [
            "-hide_banner",
            "-loglevel", "error",
            "-i", "pipe:0",
            "-ar", "16000",
            "-ac", "1",
            "-f", "wav",
            "-y",
            wavPath,
          ],
          audio,
        );

        // Transcribe. `-oj` writes <wav>.json alongside the input.
        await run(WHISPER_BIN, [
          "-m", WHISPER_MODEL,
          "-f", wavPath,
          "-t", String(WHISPER_THREADS),
          "-l", WHISPER_LANGUAGE,
          "-oj",
          "-nt",            // no timestamps in text output
          "-np",            // no progress spam
        ]);

        const jsonPath = `${wavPath}.json`;
        const parsed = JSON.parse(await readFile(jsonPath, "utf-8")) as {
          transcription?: Array<{ text?: string }>;
          result?: { language?: string };
        };

        const text = (parsed.transcription ?? [])
          .map((seg) => (seg.text ?? "").trim())
          .filter(Boolean)
          .join(" ")
          .trim();

        res.json({
          text,
          language: parsed.result?.language ?? null,
          durationMs: Date.now() - started,
          inputBytes: audio.length,
          model: WHISPER_MODEL,
        });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        rm(scratch, { recursive: true, force: true }).catch(() => {});
      }
    },
  );

  // Lightweight probe — lets wolves check whether transcription is available
  // without sending a request.
  router.get("/health", (_req: Request, res: Response) => {
    res.json({
      binary: WHISPER_BIN,
      binaryExists: existsSync(WHISPER_BIN),
      model: WHISPER_MODEL,
      modelExists: existsSync(WHISPER_MODEL),
      language: WHISPER_LANGUAGE,
      threads: WHISPER_THREADS,
    });
  });

  return router;
}
