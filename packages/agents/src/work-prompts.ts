/**
 * The work-creation prompt (`/task new`): routing plus the three stage protocols. Each is a registry prompt
 * (`new-work`, `grilling`, `to-spec`, `to-tickets`), resolved per wolf. `new-work` holds `{{domains}}`, `{{grilling}}`,
 * `{{toSpec}}` and `{{toTickets}}`; the stage protocols are inserted as resolved (their own braces are not re-expanded).
 */
import { resolvePrompt } from "./prompts.js";

export interface WorkDomain {
  name: string;
  description?: string;
}

const domainLines = (domains: readonly WorkDomain[]): string =>
  domains.length
    ? domains.map((d) => `- **${d.name}**${d.description ? ` — ${d.description}` : ""}`).join("\n")
    : "- (use one of the domains this wolf is subscribed to)";

export function newWorkPrompt(domains: readonly WorkDomain[] = [], wolfHome?: string): string {
  const parts: Record<string, string> = {
    domains: domainLines(domains),
    grilling: resolvePrompt("grilling", wolfHome).text,
    toSpec: resolvePrompt("to-spec", wolfHome).text,
    toTickets: resolvePrompt("to-tickets", wolfHome).text,
  };
  // One pass with a function replacer: `$` in an override is literal and inserted text is never re-scanned.
  return resolvePrompt("new-work", wolfHome).text.replace(/\{\{(domains|grilling|toSpec|toTickets)\}\}/g, (_m, k: string) => parts[k]!);
}
