/**
 * Pipeline — pure-code utilities shared across the knowledge system.
 * Frontmatter parsing + atomic markdown writes. No LLM.
 */

export {
  parseFrontmatter,
  parseEntryFrontmatter,
  readEntryFile,
} from "./parse.js";
export { atomicWrite, renderEntry } from "./commit.js";
