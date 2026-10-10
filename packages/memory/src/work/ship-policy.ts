/**
 * ship-policy — whether shipping a task needs a human "yes".
 *
 *   confirm (default)  ask the user before shipping, when someone can answer
 *   auto               ship without asking — for agent loops that finish work
 *                      on their own
 *
 * Set per wolf with WOLFPACK_TASK_SHIP=auto in its .env. A session with no UI
 * attached never blocks on a prompt, whatever the policy.
 */
export type ShipPolicy = "confirm" | "auto";

export function resolveShipPolicy(env: Record<string, string | undefined> = process.env): ShipPolicy {
  return env.WOLFPACK_TASK_SHIP?.trim().toLowerCase() === "auto" ? "auto" : "confirm";
}

/** Ask before shipping only when the policy wants it AND a user can answer. */
export function shouldConfirmShip(policy: ShipPolicy, hasUI: boolean): boolean {
  return policy === "confirm" && hasUI;
}
