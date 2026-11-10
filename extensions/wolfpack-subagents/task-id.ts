/**
 * Which work item a subagent works on: a memory tag only (PI_SUBAGENT_TASK), never a binding.
 * Id shape matches the KB schema (packages/kb/src/schema/work.ts): work-<domain>-<7 alphanumerics>.
 */
const WORK_ID = /(?<![A-Za-z0-9-])work-[a-z0-9]+-[0-9A-Za-z]{7}(?![A-Za-z0-9])/;

/** A valid explicit id, else the first full work id in the brief by position, else undefined. */
export function resolveSubagentTask(input: { explicit?: string; brief: string }): string | undefined {
  const explicit = input.explicit?.trim();
  if (explicit && new RegExp(`^${WORK_ID.source}$`).test(explicit)) return explicit;
  return WORK_ID.exec(input.brief)?.[0];
}
