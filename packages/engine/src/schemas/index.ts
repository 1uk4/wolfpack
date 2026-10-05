/**
 * All schemas — the contract definitions for the entire knowledge system.
 * Every LLM call in the system has its output defined by one of these schemas.
 */

export {
  ObservationSchema,
  type Observation,
} from "./observation.js";

export {
  ObservationClassificationSchema,
  BatchClassificationSchema,
  type ObservationClassification,
  type BatchClassification,
} from "./classification.js";

export {
  EntryFrontmatterSchema,
  EntrySchema,
  type EntryFrontmatter,
  type Entry,
} from "./entry.js";

export {
  ItemStatusSchema,
  LiveItemSchema,
  ItemUpdateSchema,
  type LiveItem,
  type ItemUpdate,
} from "./item.js";

export {
  AssessmentActionSchema,
  AssessmentSchema,
  type Assessment,
} from "./assessment.js";

export {
  ClaimSchema,
  ClaimWorthinessSchema,
  type Claim,
  type ClaimWorthiness,
} from "./claim.js";

export {
  RelationshipTypeSchema,
  LinkSchema,
  LinkAssessmentSchema,
  type RelationshipType,
  type Link,
  type LinkAssessment,
} from "./link.js";
