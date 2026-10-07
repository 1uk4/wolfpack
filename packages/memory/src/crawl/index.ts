/**
 * @wolfpack/memory/crawl — reproduce the memory pipeline across time.
 *
 * Deterministic front-end (discover → dates → group → plan) that feeds the
 * existing memory pipeline (observe → consolidate → journey) under a scribe
 * identity. See docs/crawl-spec.md.
 */
export * from "./schemas.js";
export {
  discoverSources,
  globToRegExp,
  matchesAny,
  DEFAULT_EXCLUDES,
  type DiscoverOptions,
} from "./discover.js";
export {
  resolveDate,
  resolveDates,
  isGitRepo,
  ordersJourney,
  normalizeDate,
  dateFromFilename,
  dateFromFrontmatter,
  dateFromGit,
  type ResolveDateOptions,
} from "./dates.js";
export {
  buildPlan,
  slugify,
  patternStem,
  batchDate,
  type BuildPlanOptions,
} from "./group.js";
export {
  writePlan,
  readPlan,
  resolveBatchFiles,
  gatePlan,
  renderPlanSummary,
  type GateContext,
} from "./plan.js";
export { createSink, DEFAULT_SINK_BASE, type CrawlSink } from "./sink.js";
export {
  planCrawl,
  runCrawl,
  mapWithConcurrencyLimit,
  DEFAULT_CRAWL_CONCURRENCY,
  type PlanCrawlOptions,
  type PlanCrawlResult,
  resumeCrawl,
  type RunCrawlOptions,
  type RunCrawlResult,
  type CrawlProgress,
  type CrawlBatchProgress,
  type CrawlBatchStage,
  type CrawlUsageStats,
} from "./cli.js";
export {
  extractBatch,
  extractCrawl,
  chunkText,
  type CrawlObservation,
  type ExtractOptions,
} from "./extract.js";
export {
  consolidateBatch,
  consolidateCrawl,
  computeTemporal,
  renderTopicDoc,
  renderDecisions,
  sortEvents,
  CRAWL_CONSOLIDATE_SYSTEM,
  CrawlTopicSchema,
  CrawlEventSchema,
  type CrawlTopic,
  type CrawlEvent,
  type TopicTemporal,
} from "./consolidate.js";
export {
  buildJourney,
  renderHistoryDoc,
  CRAWL_JOURNEY_SYSTEM,
  JourneyResultSchema,
  type JourneyResult,
} from "./journey.js";
export {
  emitCrawl,
  type EmitCrawlOptions,
  type EmitCrawlResult,
  type EmitContribution,
} from "./emit.js";
