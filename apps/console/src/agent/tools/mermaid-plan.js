const HEADER_RE = /^(graph|flowchart)\s+(td|tb|lr|rl|bt)\s*$/i;
const SLUG_RE = /^[a-z0-9]+([_-][a-z0-9]+)*$/;
/** Any arrow spelling counts as a requires-edge; chains split on it. */
const ARROW_RE = /-->|==>|-\.->/;
/** One edge endpoint: `id`, `id[title]`, or `id("title")`. */
// The id CANDIDATE class is deliberately broad — anything but whitespace,
// brackets, parens — so EVERY bad id (UPPER, dots, underscores…) reaches
// register()'s SPECIFIC slug message instead of dying at the regex layer
// with a generic parse error. The muscle-protein post-mortem: underscores
// failed HERE, the actionable message never fired, and the teacher spent
// four attempts hunting punctuation the parser didn't care about.
const ENDPOINT_RE = /^([^\s()\[\]]+)\s*(?:\[([^\[\]]*)\]|\(\s*"([^"]*)"\s*\)|\(([^()]*)\))?$/;
function parseEndpoint(text) {
    const m = text.trim().match(ENDPOINT_RE);
    if (!m || !m[1])
        return null;
    let label = (m[2] ?? m[3] ?? m[4] ?? "").trim();
    // `id["title"]` is idiomatic mermaid — don't keep the quote pair in the title.
    if (label.length >= 2 &&
        ((label.startsWith('"') && label.endsWith('"')) || (label.startsWith("'") && label.endsWith("'")))) {
        label = label.slice(1, -1).trim();
    }
    return { id: m[1], label };
}
/** Parse the mermaid subset. Collects ALL problems (never just the first). */
export function parseMermaidPlan(mermaid) {
    const problems = [];
    const lines = mermaid.split(/\r?\n/);
    // Header: required, first non-empty non-comment line.
    const first = lines.findIndex((l) => l.trim().length > 0 && !l.trim().startsWith("%%"));
    if (first === -1) {
        return { ok: false, problems: ["The plan is empty — expected a `graph TD` block with nodes and `-->` requires-edges."] };
    }
    const header = lines[first]?.trim() ?? "";
    if (!HEADER_RE.test(header)) {
        problems.push(`line ${first + 1}: expected the header \`graph TD\` (or flowchart TD/TB) first, got \`${header}\`.`);
    }
    const nodes = new Map(); // id → title (first label wins)
    const edges = [];
    const seenEdges = new Set();
    const register = ({ id, label }, lineNo) => {
        if (!SLUG_RE.test(id)) {
            problems.push(`line ${lineNo}: node id \`${id}\` must be a lowercase slug (a-z, 0-9, joined by hyphens or underscores — e.g. \`chain-rule-intuition\`); ids are permanent and checks reference them.`);
            return;
        }
        if (!nodes.has(id))
            nodes.set(id, label && label.length > 0 ? label : id);
        else if (label && label.length > 0 && nodes.get(id) === id)
            nodes.set(id, label);
    };
    for (let i = first + 1; i < lines.length; i++) {
        const line = lines[i]?.trim() ?? "";
        const no = i + 1;
        if (line.length === 0 || line.startsWith("%%"))
            continue;
        // Edges (incl. chains): split on any arrow spelling; every segment is
        // an endpoint, consecutive pairs become requires-edges.
        const segments = line.split(ARROW_RE);
        if (segments.length >= 2) {
            const endpoints = [];
            let unreadable = false;
            for (const seg of segments) {
                const ep = parseEndpoint(seg);
                if (!ep) {
                    problems.push(`line ${no}: can't read the edge \`${line}\` — expected \`a[title] --> b[title]\` (chains like \`a --> b --> c\` are fine).`);
                    unreadable = true;
                    break;
                }
                endpoints.push(ep);
            }
            if (!unreadable) {
                for (const ep of endpoints)
                    register(ep, no);
                for (let k = 0; k + 1 < endpoints.length; k++) {
                    const from = endpoints[k];
                    const to = endpoints[k + 1];
                    if (from.id === to.id) {
                        problems.push(`line ${no}: self-loop \`${from.id} --> ${to.id}\` — a node can't require itself.`);
                        continue;
                    }
                    const key = `${from.id}->${to.id}`;
                    if (!seenEdges.has(key)) {
                        seenEdges.add(key);
                        edges.push({ from: from.id, to: to.id });
                    }
                }
            }
        }
        else {
            const node = parseEndpoint(line);
            if (!node) {
                problems.push(`line ${no}: can't parse \`${line}\` — ids are the strict part (lowercase slugs: a-z, 0-9, hyphens, underscores); node lines (\`slug[title]\`) and requires-edges (\`a --> b\`) are the accepted forms; subgraphs, styles, and classes are not part of the subset.`);
                continue;
            }
            register(node, no);
        }
    }
    const plan = {
        nodes: [...nodes.entries()].map(([id, title]) => ({ id, title })),
        edges,
    };
    if (problems.length > 0)
        return { ok: false, problems };
    if (plan.nodes.length === 0)
        return { ok: false, problems: ["No nodes found — the plan needs at least one."] };
    return { ok: true, problems: [], plan };
}
//# sourceMappingURL=mermaid-plan.js.map