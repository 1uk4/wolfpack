/** What the KB said about a topic after promote (from its receipts / distill record). Its own module so den-reconcile and promote-pass can both use it without importing each other. */
export type TopicOutcome =
  | { kind: "create" | "merge"; entryIds: string[] }
  | { kind: "reject" }
  | { kind: "parked" }
  | { kind: "held"; reason: string }
  | { kind: "pending" };
