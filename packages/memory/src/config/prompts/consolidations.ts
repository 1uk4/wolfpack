export const PACK_ALREADY_KNOWS_RUNNING_DIGEST_TEMPLATE = `
===== PACK ALREADY KNOWS (running digest) =====
{{sectionLines}}
===== END PACK ALREADY KNOWS =====
`;

export const SESSION_CONSOLIDATION_USER_PROMPT = `===== OBSERVATIONS TO CONSOLIDATE =====
{{obsLines}}
===== END OBSERVATIONS =====

===== EXISTING SESSION TOPICS =====
{{existingSection}}
===== END SESSION TOPICS =====

{{journeyBlock}}
Fold the observations into session topics. For each group of related observations, decide MERGE, CREATE, or SKIP.`;

export const CRAWL_CONSOLIDATION_USER_PROMPT = `TOPIC: {{topic}}
CURRENCY: {{currency}}  (archived/snapshot = historical; present as of its dates)

===== OBSERVATIONS (all belong to this ONE topic) =====
{{obsLines}}
===== END OBSERVATIONS =====

{{existingBlock}}
{{packKnowsBlock}}
Fold the observations into ONE current-state entry. Respond with JSON.`;

export const CRAWL_JOURNEY_USER_PROMPT = `DOMAIN: {{domain}}

{{currentBlock}}

===== NEW EVENTS (chronological, oldest first) =====
{{eventLines}}
===== END EVENTS =====

Extend the journey with these events. Narrate what changed; do not list specifications. Respond with JSON.`;
