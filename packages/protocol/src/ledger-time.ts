/**
 * Ledger event times. Older events carry `at` as "YYYY-MM-DD HH:MM" (UTC, no zone); newer ones are full ISO.
 * Date.parse reads the zone-less form as LOCAL time, so a reader west of UTC sees it in the future. Always parse through here.
 * Dependency-free and browser-safe.
 */
const LEGACY_AT = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(:\d{2})?$/;

/** Normalise a ledger time to a string Date.parse reads as UTC ("YYYY-MM-DD HH:MM[:SS]" -> ISO with Z); anything else is returned as is. */
export function ledgerTimeIso(at: string): string {
  const m = LEGACY_AT.exec(at);
  return m ? `${m[1]}T${m[2]}${m[3] ?? ":00"}Z` : at;
}

/** Epoch ms of a ledger time (zone-less form read as UTC); NaN when unparseable. */
export function parseLedgerTime(at: string): number {
  return Date.parse(ledgerTimeIso(at));
}
