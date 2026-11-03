import { describe, expect, it } from "vitest";
import { toLinkWolf } from "./link-wolf.js";

const w = (memory?: { librarian?: boolean; hubKb?: boolean }) => ({ identity: { name: "hal2", domains: ["personal"] }, ...(memory ? { memory } : {}) });
describe("toLinkWolf kbReadable", () => {
  it("wolf.yaml memory.hubKb true -> kbReadable; absent or false -> not", () => {
    expect(toLinkWolf(w({ hubKb: true }), {})).toMatchObject({ librarian: false, kbReadable: true });
    expect(toLinkWolf(w({}), {}).kbReadable).toBe(false);
    expect(toLinkWolf(w({ hubKb: false }), {}).kbReadable).toBe(false);
    expect(toLinkWolf(w(), {}).kbReadable).toBe(false);
  });
  it("keeps the librarian and workerd-env rules", () => {
    expect(toLinkWolf(w({ librarian: true }), {})).toMatchObject({ librarian: true, kbReadable: true });
    expect(toLinkWolf(w(), { WOLFPACK_HUB_KB: "1" }).kbReadable).toBe(true);
    expect(toLinkWolf(w(), { KB_BASE: "/b", KB_OPS: "/o" }).kbReadable).toBe(true);
    expect(toLinkWolf(w(), { KB_BASE: "/b" }).kbReadable).toBe(false);
  });
});
