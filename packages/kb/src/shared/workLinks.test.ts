import { describe, it, expect } from "vitest";
import { deliveredBullets, mergeDelivered, renderDelivered, stripProseDelivered } from "./workLinks.js";

const A = "kb-wolfpack-AAAAAAA";
const B = "kb-wolfpack-BBBBBBB";

describe("Delivered", () => {
  it("renders a bullet with or without links", () => {
    expect(renderDelivered({ title: "Base image", links: [A, B, A] })).toBe(`- Base image: [[${A}]], [[${B}]]`);
    expect(renderDelivered({ title: "Compose", links: [] })).toBe("- Compose");
  });

  it("reads the bullets of the section only", () => {
    const body = `## Scope\n\n- not me: [[${B}]]\n\n## Delivered\n\n- Base image: [[${A}]]\n- Compose\n\n## History\n\n- x`;
    expect(deliveredBullets(body)).toEqual([{ title: "Base image", links: [A] }, { title: "Compose", links: [] }]);
  });

  it("adds the section before History, or at the end", () => {
    expect(mergeDelivered("## Scope\n\nx\n\n## History\n\n- h", [{ title: "F", links: [A] }])).toBe(`## Scope\n\nx\n\n## Delivered\n\n- F: [[${A}]]\n\n## History\n\n- h`);
    expect(mergeDelivered("## Scope\n\nx", [{ title: "F", links: [] }])).toBe("## Scope\n\nx\n\n## Delivered\n\n- F\n");
  });

  it("merges into an existing bullet by title, adding only missing links", () => {
    const body = `## Delivered\n\n- Base image: [[${A}]]\n- Other\n\n## History\n\n- h`;
    const out = mergeDelivered(body, [{ title: "base image", links: [A, B] }, { title: "Other", links: [A] }, { title: "New", links: [] }]);
    expect(out).toBe(`## Delivered\n\n- Base image: [[${A}]], [[${B}]]\n- Other: [[${A}]]\n- New\n\n## History\n\n- h`);
    expect(mergeDelivered(out, [{ title: "Base image", links: [A, B] }])).toBe(out);
  });

  it("replaces a prose 'Delivered by' heading or paragraph with the list", () => {
    const heading = "## Scope\n\nx\n\n## Delivered by the sweep work\n\nSome prose about it.\n\n- loose bullet\n\n## History\n\n- h";
    expect(mergeDelivered(heading, [{ title: "F", links: [A] }])).toBe(`## Scope\n\nx\n\n## Delivered\n\n- F: [[${A}]]\n\n## History\n\n- h`);
    const para = "## Scope\n\nx\n\nDelivered by F and G over two weeks.\nStill that paragraph.\n\n## History\n\n- h";
    const out = mergeDelivered(para, [{ title: "F", links: [A] }]);
    expect(out).not.toContain("Delivered by");
    expect(out.match(/## Delivered/g)).toHaveLength(1);
    expect(stripProseDelivered("## Delivered\n\n- F")).toBe("## Delivered\n\n- F");
  });
});
