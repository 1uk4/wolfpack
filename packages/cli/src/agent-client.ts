/**
 * HTTP client for talking to a wolfpack-agent on a remote host.
 */

import type { HostEntry } from "./config.js";

export class AgentClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(host: HostEntry) {
    this.baseUrl = `http://${host.address}:${host.port}`;
    this.apiKey = host.apiKey;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        "X-API-Key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      let msg: string;
      try {
        msg = JSON.parse(text).error ?? text;
      } catch {
        msg = text;
      }
      throw new Error(`Agent error (${res.status}): ${msg}`);
    }

    return res.json();
  }

  /** Check agent is reachable */
  async ping(): Promise<{ status: string; version: string }> {
    return this.request("GET", "/ping") as Promise<{ status: string; version: string }>;
  }

  /** List all wolves */
  async listWolves(): Promise<unknown> {
    return this.request("GET", "/wolves");
  }

  /** Get wolf status */
  async wolfStatus(nameOrId: string): Promise<unknown> {
    return this.request("GET", `/wolves/${encodeURIComponent(nameOrId)}`);
  }

  /** Create a wolf */
  async createWolf(body: unknown): Promise<unknown> {
    return this.request("POST", "/wolves", body);
  }

  /** Update wolf config */
  async updateWolfConfig(nameOrId: string, updates: unknown): Promise<unknown> {
    return this.request("PATCH", `/wolves/${encodeURIComponent(nameOrId)}/config`, updates);
  }

  /** Restart wolf */
  async restartWolf(nameOrId: string): Promise<unknown> {
    return this.request("POST", `/wolves/${encodeURIComponent(nameOrId)}/restart`);
  }

  /** Stop wolf */
  async stopWolf(nameOrId: string): Promise<unknown> {
    return this.request("POST", `/wolves/${encodeURIComponent(nameOrId)}/stop`);
  }

  /** Remove wolf */
  async removeWolf(nameOrId: string): Promise<unknown> {
    return this.request("DELETE", `/wolves/${encodeURIComponent(nameOrId)}`);
  }

  /** Get host health */
  async health(): Promise<unknown> {
    return this.request("GET", "/health");
  }

  /** Get wolf logs */
  async logs(nameOrId: string, lines = 100): Promise<unknown> {
    return this.request("GET", `/logs/${encodeURIComponent(nameOrId)}?lines=${lines}`);
  }

  /** Stream wolf logs (SSE) — returns a ReadableStream */
  async streamLogs(
    nameOrId: string,
    onLine: (line: string) => void,
    lines = 100,
  ): Promise<void> {
    const url = `${this.baseUrl}/logs/${encodeURIComponent(nameOrId)}?follow=true&lines=${lines}`;
    const res = await fetch(url, {
      headers: { "X-API-Key": this.apiKey },
    });

    if (!res.ok || !res.body) {
      throw new Error(`Failed to stream logs: ${res.statusText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value);
      for (const chunk of text.split("\n\n")) {
        if (chunk.startsWith("data: ")) {
          onLine(chunk.substring(6));
        }
      }
    }
  }
}
