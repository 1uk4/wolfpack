import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatDomainChoices, listSubscribedDomains, readDomainRegistry, resolveDomainsFile } from "./domain-registry.js";

function kb(): string {
  const base = mkdtempSync(join(tmpdir(), "kb-dom-"));
  for (const d of ["alpha", "beta", "_hidden"]) mkdirSync(join(base, "domains", d), { recursive: true });
  writeFileSync(join(base, "domains.yaml"), "domains:\n  alpha:\n    label: Alpha\n    description: The A one\n");
  return base;
}

describe("listSubscribedDomains", () => {
  it("lists mirrored domain folders with registry labels", () => {
    expect(listSubscribedDomains(kb(), {})).toEqual([
      { name: "alpha", label: "Alpha", description: "The A one" },
      { name: "beta" },
    ]);
  });
  it("WOLF_DOMAINS wins over folders", () => {
    const got = listSubscribedDomains(kb(), { WOLF_DOMAINS: "beta, gamma" });
    expect(got.map((d) => d.name)).toEqual(["beta", "gamma"]);
  });
  it("is empty with nothing configured", () => {
    expect(listSubscribedDomains(undefined, {})).toEqual([]);
    expect(formatDomainChoices([])).toBe("one of your subscribed domains");
  });
  it("formats choices", () => {
    expect(formatDomainChoices([{ name: "a" }, { name: "b" }])).toBe("a | b");
  });
});

describe("readDomainRegistry color", () => {
  it("passes an optional color through, only when set", () => {
    const base = mkdtempSync(join(tmpdir(), "kb-dom-"));
    writeFileSync(join(base, "domains.yaml"), "domains:\n  a:\n    label: A\n    color: '#123456'\n  b:\n    label: B\n");
    const r = readDomainRegistry(base);
    expect(r.a.color).toBe("#123456");
    expect("color" in r.b).toBe(false);
  });
});

describe("resolveDomainsFile / fallback", () => {
  const home = () => {
    const h = mkdtempSync(join(tmpdir(), "kb-home-"));
    writeFileSync(join(h, "domains.yaml"), "domains:\n  gamma:\n    label: Gamma\n");
    return h;
  };
  it("keeps <kbBase>/domains.yaml when it exists", () => {
    const base = kb();
    expect(resolveDomainsFile(base, { WOLFPACK_REGISTRY_DIR: home() })).toBe(join(base, "domains.yaml"));
    expect(readDomainRegistry(base, { WOLFPACK_REGISTRY_DIR: home() }).alpha?.label).toBe("Alpha");
  });
  it("falls back to ~/.wolfpack/domains.yaml when the mirror has none", () => {
    const base = mkdtempSync(join(tmpdir(), "kb-mirror-"));
    const h = home();
    expect(resolveDomainsFile(base, { WOLFPACK_REGISTRY_DIR: h })).toBe(join(h, "domains.yaml"));
    expect(readDomainRegistry(base, { WOLFPACK_REGISTRY_DIR: h }).gamma?.label).toBe("Gamma");
  });
  it("WOLFPACK_DOMAINS_FILE wins over both", () => {
    const f = join(mkdtempSync(join(tmpdir(), "kb-ovr-")), "d.yaml");
    writeFileSync(f, "domains:\n  delta:\n    label: Delta\n");
    const env = { WOLFPACK_REGISTRY_DIR: home(), WOLFPACK_DOMAINS_FILE: f };
    expect(Object.keys(readDomainRegistry(kb(), env))).toEqual(["delta"]);
  });
  it("is null/empty when nothing exists", () => {
    const base = mkdtempSync(join(tmpdir(), "kb-none-"));
    const env = { WOLFPACK_REGISTRY_DIR: mkdtempSync(join(tmpdir(), "kb-nohome-")) };
    expect(resolveDomainsFile(base, env)).toBeNull();
    expect(readDomainRegistry(base, env)).toEqual({});
  });
});
