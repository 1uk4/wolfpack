/**
 * Simple API key authentication middleware.
 * Key is stored in WOLFPACK_AGENT_API_KEY env var on the agent (set by the
 * systemd unit at deploy time).
 */

import type { Request, Response, NextFunction } from "express";

export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const apiKey = process.env.WOLFPACK_AGENT_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Agent API key not configured" });
    return;
  }

  const provided = req.headers["x-api-key"];
  if (!provided || provided !== apiKey) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}
