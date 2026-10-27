/**
 * Crawl planning mode for durable wolves, per conversation: while a crawl interview/plan is in progress the observer
 * skips that conversation's turns (pi's `crawlPlanMode`), so reading source files never lands in the den.
 * Shared between the crawl tools (unified-crawl.ts) and the observer (unified.ts) through this module.
 */
const planning = new Map<string, Set<number>>();
const reseed = new Map<string, Set<number>>();
const epochs = new Map<string, number>();
const key = (den: string) => den;
const bump = (den: string, conv: number) => epochs.set(`${den}\0${conv}`, (epochs.get(`${den}\0${conv}`) ?? 0) + 1);
const bucket = (m: Map<string, Set<number>>, den: string) => {
  let s = m.get(key(den));
  if (!s) m.set(key(den), (s = new Set()));
  return s;
};

export const crawlMode = {
  begin(den: string, conversationId: number): void {
    bump(den, conversationId);
    bucket(planning, den).add(conversationId);
    bucket(reseed, den).delete(conversationId);
  },
  /** Planning is over; the first observation afterwards re-seeds its watermark past the planning turns. */
  end(den: string, conversationId: number): void {
    bump(den, conversationId);
    if (bucket(planning, den).delete(conversationId)) bucket(reseed, den).add(conversationId);
  },
  /** Changes whenever planning begins or ends here: an observation that straddles a change must be dropped. */
  epoch: (den: string, conversationId: number): number => epochs.get(`${den}\0${conversationId}`) ?? 0,
  active: (den: string, conversationId: number): boolean => bucket(planning, den).has(conversationId),
  /** True once after planning ended (consumes the flag). */
  takeReseed: (den: string, conversationId: number): boolean => bucket(reseed, den).delete(conversationId),
};
