export function findSessionTextMatches(text, query) {
    if (!query)
        return [];
    // Escape the user's string, never expose regex semantics. RegExp retains
    // ORIGINAL UTF-16 offsets, unlike lowercasing text (İ can change length).
    const literal = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(literal, "giu");
    return Array.from(text.matchAll(pattern), (m) => ({ start: m.index, end: m.index + m[0].length }));
}
export function stepSessionMatch(index, count, direction) {
    if (!count)
        return -1;
    return ((index + direction) % count + count) % count;
}
//# sourceMappingURL=session-find.js.map