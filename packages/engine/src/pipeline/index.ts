/**
 * Pipeline — the five engine functions.
 * Pure code utilities + wrappers for LLM calls via the adapter.
 */

export { parseFrontmatter, parseClaim, parseEntryFrontmatter, readEntryFile } from "./parse.js";
export { searchDomain, searchDomains, type SearchHit, type SearchResult } from "./search.js";
export {
  atomicWrite,
  renderEntry,
  renderItem,
  renderClaim,
  writeReceipt,
} from "./commit.js";
export {
  scanEntries,
  detectClusters,
  computeBacklinks,
  renderDomainIndex,
  generateDomainIndex,
  type IndexEntry,
  type Cluster,
} from "./index-gen.js";
