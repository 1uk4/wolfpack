/**
 * Tests for the section parsers (settings-storage wave, 2026-09-19):
 * src/server/settings-body.ts — general/agent/appearance/graph strictness.
 * Same discipline as parseSettingsBody (its tests live in
 * default-settings.test.ts): every known field is strict (bad type/shape
 * → 400-style error, never a silent clamp), unknown keys drop, absent
 * fields mean absent overrides. Pure — no fs.
 */
export {};
//# sourceMappingURL=settings-body.test.d.ts.map