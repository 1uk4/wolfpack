/** Unified line diff (default 3 lines of context), LCS based. Topics are a few KB, so O(n*m) is fine. Empty string when equal. */
export function unifiedLineDiff(a: string, b: string, context = 3): string {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  type Op = { t: " " | "-" | "+"; s: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { ops.push({ t: " ", s: x[i]! }); i++; j++; }
    else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) ops.push({ t: "+", s: y[j++]! });
    else ops.push({ t: "-", s: x[i++]! });
  }
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, k) => { if (o.t !== " ") for (let d = -context; d <= context; d++) if (ops[k + d]) keep[k + d] = true; });
  const out: string[] = [];
  let a0 = 1;
  let b0 = 1;
  for (let k = 0; k < ops.length; ) {
    if (!keep[k]) { if (ops[k]!.t !== "+") a0++; if (ops[k]!.t !== "-") b0++; k++; continue; }
    let e = k;
    while (e < ops.length && keep[e]) e++;
    const hunk = ops.slice(k, e);
    const al = hunk.filter((o) => o.t !== "+").length;
    const bl = hunk.filter((o) => o.t !== "-").length;
    out.push(`@@ -${a0},${al} +${b0},${bl} @@`, ...hunk.map((o) => `${o.t}${o.s}`));
    a0 += al;
    b0 += bl;
    k = e;
  }
  return out.join("\n");
}
