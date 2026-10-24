export type ReleaseAsset = {
    id: number;
    name: string;
    size: number;
    state: string;
};
export type ReleaseRecord = {
    id: number;
    tag_name: string;
    draft: boolean;
    assets: ReleaseAsset[];
};
export type Failures = {
    ok: false;
    errors: string[];
};
export type DraftSelection = {
    ok: true;
    release: ReleaseRecord;
    warnings: string[];
} | Failures;
/** The full expected asset inventory for one version (11 files). */
export type ExpectedAssets = {
    version: string;
    mac: {
        dmg: string;
        zip: string;
        feed: string;
    };
    win: {
        exe: string;
        feed: string;
    };
    linux: {
        appImage: string;
        deb: string;
        feed: string;
    };
    /** Every asset name the draft must hold, and no others. */
    files: string[];
};
type Issue = string;
type Issues = Issue[];
export declare function checkVersion(version: unknown): {
    ok: true;
    version: string;
} | {
    ok: false;
    errors: Issues;
};
/** The exact asset set the installed builder emits for this repo's config. */
export declare function expectedAssets(version: string): ExpectedAssets;
/**
 * `gh api --paginate --slurp` emits an array of pages ([[...], [...]]); a
 * hand-made single page is a plain array. Both are accepted, everything
 * else fails.
 */
export declare function normalizeReleasePages(input: unknown): {
    ok: true;
    releases: unknown[];
} | {
    ok: false;
    errors: Issues;
};
export declare function parseReleases(entries: unknown[]): {
    ok: true;
    releases: ReleaseRecord[];
} | {
    ok: false;
    errors: Issues;
};
export declare function selectDraft(releases: ReleaseRecord[], tag: string, version: string): DraftSelection;
/** Names below were derived from these exact config shapes; drift means the
 *  expectations in this file must be re-derived against the new builder
 *  output. Failing here is deliberate: a silently stale gate is worse. */
export declare function verifyConfigAssumptions(config: unknown, pkg: unknown): {
    ok: true;
} | {
    ok: false;
    errors: Issues;
};
export declare function verifyAssets(release: ReleaseRecord, expected: ExpectedAssets): {
    ok: true;
} | {
    ok: false;
    errors: Issues;
};
type FeedExpectation = {
    file: string;
    /** Every files[].url the feed must reference — exactly these, no more. */
    urls: string[];
    /** If set, files[0].url must be this entry (mac: the updater ZIP). */
    first?: string;
};
export declare function feedExpectations(expected: ExpectedAssets): FeedExpectation[];
/** An updater reference must be a bare file name: no directories, no
 *  traversal, no URI scheme, no query/fragment. Anything else is a path the
 *  updater could be steered with. */
export declare function isPlainAssetName(url: unknown): url is string;
export declare function verifyMetadataFiles(files: Record<string, string>, release: ReleaseRecord, expected: ExpectedAssets): {
    ok: true;
} | {
    ok: false;
    errors: Issues;
};
export {};
//# sourceMappingURL=verify-release.d.ts.map