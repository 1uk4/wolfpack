import { describe, expect, it } from "vitest";
import { sshKeyArgs, sshKeyFlags } from "./ssh-helper.js";

describe("ssh key options", () => {
  it("uses only the key file, never the ssh-agent", () => {
    expect(sshKeyArgs("/k/wolfpack")).toEqual(["-i", "/k/wolfpack", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none"]);
  });
  it("quotes the key path in the shell form", () => {
    expect(sshKeyFlags("/My Keys/wolfpack")).toBe('-i "/My Keys/wolfpack" -o IdentitiesOnly=yes -o IdentityAgent=none');
  });
});
