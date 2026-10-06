/**
 * Schemas — the contract definitions for the knowledge engine.
 * The curated KB entry is the one shared schema; everything task-specific
 * (observer, consolidation, KB oracles) is defined in the consuming package.
 */

export {
  EntryFrontmatterSchema,
  EntrySchema,
  type EntryFrontmatter,
  type Entry,
} from "./entry.js";
