import { describe, expect, it } from "vitest";
import { hubdPort, kbOpsDir, packStateDir, runDir, wolvesDir, wolvesRoot, workerdConfigDir, workerdPort } from "./runtime-home.js";

describe("runtime home resolver", () => {
  it("defaults to the dev-stack values", () => {
    const env = { HOME: "/h" };
    expect([packStateDir(env), workerdConfigDir(env), wolvesRoot(env), wolvesDir(env), kbOpsDir(env), runDir(env)]).toEqual([
      "/h/.wolfpack", "/h/.wolfpack/workerd", "/h/wolves", "/h/wolves/local", "/h/wolves/librarian", "/h/.wolfpack/run",
    ]);
    expect([workerdPort(env), hubdPort(env), hubdPort(env, 3150)]).toEqual([7141, 3142, 3150]);
  });
  it("WOLFPACK_HOME moves the state dir, workerd's dir and the run dir, but not kb ops", () => {
    const env = { HOME: "/h", WOLFPACK_HOME: "/s" };
    expect([packStateDir(env), workerdConfigDir(env), runDir(env), kbOpsDir(env)]).toEqual(["/s", "/s/workerd", "/s/run", "/h/wolves/librarian"]);
  });
  it("WORKERD_CONFIG_DIR beats the derived workerd dir", () => {
    expect(workerdConfigDir({ HOME: "/h", WOLFPACK_HOME: "/s", WORKERD_CONFIG_DIR: "/c" })).toBe("/c");
  });
  it("WOLFPACK_WOLVES_DIR alone sets the wolf folders and leaves the wolves root", () => {
    const env = { HOME: "/h", WOLFPACK_WOLVES_DIR: "/w" };
    expect([wolvesDir(env), wolvesRoot(env), kbOpsDir(env)]).toEqual(["/w", "/h/wolves", "/h/wolves/librarian"]);
  });
  it("WOLFPACK_WOLVES_ROOT moves the wolf folders and librarian under it", () => {
    const env = { HOME: "/h", WOLFPACK_WOLVES_ROOT: "/r" };
    expect([wolvesDir(env), kbOpsDir(env)]).toEqual(["/r/local", "/r/librarian"]);
  });
  it("WOLFPACK_WOLVES_DIR wins over the root for the wolf folders only", () => {
    const env = { HOME: "/h", WOLFPACK_WOLVES_ROOT: "/r", WOLFPACK_WOLVES_DIR: "/w" };
    expect([wolvesDir(env), kbOpsDir(env)]).toEqual(["/w", "/r/librarian"]);
  });
  it("WOLFPACK_KB_OPS beats the wolves-root default", () => {
    expect(kbOpsDir({ HOME: "/h", WOLFPACK_WOLVES_ROOT: "/r", WOLFPACK_KB_OPS: "/k" })).toBe("/k");
  });
  it("the port variables set the ports; WORKERD_PORT is not read", () => {
    const env = { HOME: "/h", WOLFPACK_WORKERD_PORT: "7291", WOLFPACK_HUBD_PORT: "3251", WORKERD_PORT: "7000" };
    expect([workerdPort(env), hubdPort(env, 3150)]).toEqual([7291, 3251]);
    expect(workerdPort({ HOME: "/h", WORKERD_PORT: "7000" })).toBe(7141);
  });
  it("an empty or whitespace value counts as unset", () => {
    const env = { HOME: "/h", WOLFPACK_HOME: "  ", WOLFPACK_WOLVES_ROOT: "", WOLFPACK_WOLVES_DIR: " ", WOLFPACK_KB_OPS: "", WOLFPACK_WORKERD_PORT: "", WOLFPACK_HUBD_PORT: " " };
    expect([packStateDir(env), wolvesDir(env), kbOpsDir(env), workerdPort(env), hubdPort(env)]).toEqual(["/h/.wolfpack", "/h/wolves/local", "/h/wolves/librarian", 7141, 3142]);
  });
  it("a non-numeric port throws and names the variable", () => {
    expect(() => workerdPort({ WOLFPACK_WORKERD_PORT: "abc" })).toThrow(/WOLFPACK_WORKERD_PORT must be a port number, got "abc"/);
    expect(() => hubdPort({ WOLFPACK_HUBD_PORT: "99999" })).toThrow(/WOLFPACK_HUBD_PORT/);
  });
});
