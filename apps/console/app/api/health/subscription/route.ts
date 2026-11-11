import { healthApi } from "@/src/server";
import { createSubscriptionHandler } from "@/src/server/subscription-api";

export const dynamic = "force-dynamic";

/** This host's release channel and update mode (src/server/subscription-api.ts). Both verbs need a verified device bearer. */
const sub = () => createSubscriptionHandler({ gate: (req) => healthApi().gate(req, "subscription") });

export const GET = (req: Request): Promise<Response> => sub().get(req);
export const PUT = (req: Request): Promise<Response> => sub().put(req);
