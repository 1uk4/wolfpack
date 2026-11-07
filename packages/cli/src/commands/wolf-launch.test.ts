import { describe, expect, it } from "vitest";
import { piSpawnOptions } from "./wolf-launch.js";

describe("terminal pi launch", () => {
  it("hands the pi child an env marked as an agent run, without changing the caller's env", () => {
    const env = { PATH: "/bin", WOLF_NAME: "w" };
    const o = piSpawnOptions("/work", env);
    expect(o).toMatchObject({ cwd: "/work", stdio: "inherit", env: { PATH: "/bin", WOLF_NAME: "w", WOLFPACK_AGENT_RUN: "1" } });
    expect(env).toEqual({ PATH: "/bin", WOLF_NAME: "w" });
  });
});
