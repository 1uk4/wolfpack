/**
 * Pipeline — pure-code utilities shared across the knowledge system.
 * Frontmatter parsing + atomic markdown writes. No LLM.
 */

export { parseFrontmatter } from "./parse.js";
export { atomicWrite } from "./commit.js";
