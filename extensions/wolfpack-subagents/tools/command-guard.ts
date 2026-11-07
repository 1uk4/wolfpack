/** The read-only command guard and the test-run router live in @wolfpack/agents so wolfd's `guarded_bash` shares it with the terminal pi's. */
export { checkReadOnlyCommand, routeTestCommand } from "@wolfpack/agents";
