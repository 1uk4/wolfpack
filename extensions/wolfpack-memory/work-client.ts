/**
 * Work API client — typed HTTP client for the shared work API.
 *
 * Reads WORK_ENDPOINT and WORK_TOKEN from env. All wolves hit the same
 * endpoint on the wolfpack agent (sfo-01:3141/work).
 */

import type { WorkItem, CreateWorkInput, WorkQuery } from "@wolfpack/kb/client";

export class WorkClient {
  private endpoint: string;
  private token: string;

  constructor(endpoint?: string, token?: string) {
    this.endpoint = (endpoint ?? process.env.WORK_ENDPOINT ?? "").replace(/\/$/, "");
    this.token = token ?? process.env.WORK_TOKEN ?? "";
  }

  get configured(): boolean {
    return !!(this.endpoint && this.token);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.configured) {
      throw new Error("Work API not configured (WORK_ENDPOINT / WORK_TOKEN missing)");
    }

    const url = `${this.endpoint}/work${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        "X-API-Key": this.token,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await res.json() as Record<string, unknown>;

    if (!res.ok) {
      throw new Error(String(data.error ?? `HTTP ${res.status}`));
    }

    return data as T;
  }

  async create(input: CreateWorkInput): Promise<{ id: string; item: WorkItem }> {
    return this.request("POST", "", input);
  }

  async get(id: string): Promise<WorkItem> {
    const res = await this.request<{ item: WorkItem }>("GET", `/${id}`);
    return res.item;
  }

  async query(q: WorkQuery = {}): Promise<WorkItem[]> {
    const params = new URLSearchParams();
    if (q.domain) params.set("domain", q.domain);
    if (q.kind) params.set("kind", q.kind);
    if (q.stage) params.set("stage", q.stage);
    if (q.assignee) params.set("assignee", q.assignee);
    if (q.area) params.set("area", q.area);
    if (q.partOf) params.set("partOf", q.partOf);
    const qs = params.toString();
    const res = await this.request<{ items: WorkItem[] }>("GET", qs ? `?${qs}` : "");
    return res.items;
  }

  async stage(id: string, to: string): Promise<WorkItem> {
    const res = await this.request<{ item: WorkItem }>("PATCH", `/${id}`, { stage: to });
    return res.item;
  }

  async note(id: string, text: string): Promise<WorkItem> {
    const res = await this.request<{ item: WorkItem }>("PATCH", `/${id}`, { note: text });
    return res.item;
  }

  async retitle(id: string, title: string): Promise<WorkItem> {
    const res = await this.request<{ item: WorkItem }>("PATCH", `/${id}`, { title });
    return res.item;
  }

  async setCriteria(id: string, criteria: string): Promise<WorkItem> {
    const res = await this.request<{ item: WorkItem }>("PATCH", `/${id}`, { successCriteria: criteria });
    return res.item;
  }

  async assign(id: string, assignee: string): Promise<WorkItem> {
    const res = await this.request<{ item: WorkItem }>("PATCH", `/${id}`, { assignee });
    return res.item;
  }

  async move(id: string, to: string): Promise<WorkItem> {
    const res = await this.request<{ item: WorkItem }>("PATCH", `/${id}`, { moveTo: to });
    return res.item;
  }

  async link(id: string, rel: string, target: string): Promise<WorkItem> {
    const res = await this.request<{ item: WorkItem }>("PATCH", `/${id}`, { link: { rel, target } });
    return res.item;
  }

  async unlink(id: string, rel: string, target: string): Promise<WorkItem> {
    const res = await this.request<{ item: WorkItem }>("PATCH", `/${id}`, { unlink: { rel, target } });
    return res.item;
  }

  async updateBody(id: string, body: string): Promise<WorkItem> {
    const res = await this.request<{ item: WorkItem }>("PATCH", `/${id}`, { body });
    return res.item;
  }

  async delete(id: string): Promise<string[]> {
    const res = await this.request<{ deleted: string[] }>("DELETE", `/${id}`);
    return res.deleted;
  }
}
