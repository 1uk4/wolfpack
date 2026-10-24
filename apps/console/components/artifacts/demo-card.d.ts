import type { ArtifactPartProps } from "@/src/core";
/**
 * Demo artifact card (W6): while the part is input-available, a job activity
 * card (the chat view's jobs feed — the job-card idiom); when output-available, the demo
 * runs in a SANDBOXED iframe (sandbox="allow-scripts", no allow-same-origin →
 * no access to app storage/cookies/DOM).
 *
 * The bridge script (contracts.ts "Demo iframe bridge") is auto-injected into
 * every demo by buildDemoSrcDoc — never the model's job: ResizeObserver →
 * postMessage {type:"demo-resize",height} (parent sizes the iframe) and
 * window.onerror → {type:"demo-error",message} (error chip on the card, with
 * a "Send to teacher" button that feeds the error back into the lesson — the
 * fix loop).
 *
 * Bridge message handling is a pure function (reduceDemoBridgeState) so
 * tests cover it without a DOM.
 */
export declare const DEMO_BRIDGE_SCRIPT = "<script>(function(){\nvar send=function(m){try{parent.postMessage(m,\"*\")}catch(e){}};\nvar post=function(){\nvar b=document.body;\nif(!b){send({type:\"demo-resize\",height:document.documentElement.scrollHeight});return}\nvar h=Math.max(b.scrollHeight,b.getBoundingClientRect().height);\nvar cs=getComputedStyle(b);\nh+=(parseFloat(cs.marginTop)||0)+(parseFloat(cs.marginBottom)||0);\nsend({type:\"demo-resize\",height:Math.ceil(h)})\n};\nif(typeof ResizeObserver!==\"undefined\"){new ResizeObserver(post).observe(document.documentElement)}\nwindow.addEventListener(\"resize\",post);\nwindow.addEventListener(\"load\",post);\nwindow.addEventListener(\"error\",function(e){send({type:\"demo-error\",message:e.message||String(e)})});\nsetTimeout(post,50);\nsetTimeout(post,400);\n})();</script>";
/** Inject the bridge before </body> (or at the end of a body-less document). */
export declare function buildDemoSrcDoc(html: string): string;
export interface DemoBridgeState {
    height: number | null;
    error: string | null;
}
export declare const INITIAL_DEMO_BRIDGE_STATE: DemoBridgeState;
/** Pure reducer over incoming postMessage data (contracts.ts DemoBridgeMessage). */
export declare function reduceDemoBridgeState(state: DemoBridgeState, data: unknown): DemoBridgeState;
/** The demo tool-call box: the part's output is the dispatch ack — the box
 * is the DispatchCard (live status via the chat view's jobs feed). The demo
 * itself renders from the steer message via DemoOutputCard. */
export declare function DemoCard({ part }: ArtifactPartProps): any;
/** The demo artifact — exported: the steer card renders the delivered
 *  result. `messageId` + `initialInverted` carry the PERSISTED invert
 *  switch (details.ui.inverted via the artifact-ui route, owner 2026-10-07). */
export declare function DemoOutputCard({ output, messageId, initialInverted, }: {
    output: unknown;
    messageId?: string;
    initialInverted?: boolean;
}): any;
export declare function DemoErrorChip({ title, message, onSend, }: {
    title: string;
    message: string;
    onSend?: () => void;
}): any;
//# sourceMappingURL=demo-card.d.ts.map