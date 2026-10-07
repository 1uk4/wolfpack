/**
 * ledger — the shared event-sourcing primitive (the "database").
 */
export {
  createEventLog,
  foldEvents,
  type EventLog,
  type EventLogOptions,
  type BaseEvent,
} from "./event-log.js";
