import { Type } from "typebox";
import { serverExecute } from "../tool-execute.ts";
export const researchInputSchema = Type.Object({
    question: Type.String({
        description: "The single research question to answer. Make it specific — the researcher sees nothing else of the lesson.",
    }),
    context: Type.Optional(Type.String({
        description: "Why you need this / what the lesson needs it for — focuses the brief. One or two sentences.",
    })),
});
export const demoInputSchema = Type.Object({
    title: Type.String({ description: "Short title for the demo card, e.g. 'Damped harmonic oscillator'." }),
    brief: Type.String({
        description: "Precise brief for the builder: the concept, the parameters/controls and what each does, the interactions, and the visual style. " +
            "The builder sees NOTHING else of the lesson — include everything it needs, including necessary formulas and constants.",
    }),
});
export const visualInputSchema = Type.Object({
    brief: Type.String({
        description: "Precise brief for ONE static figure: exactly what it must show — coordinates, labels, proportions, orientation. " +
            "The maker sees NOTHING else of the lesson; a wrong or vague brief produces a wrong figure.",
    }),
});
export const pdfInputSchema = Type.Object({
    path: Type.String({ description: "Path to the learner's PDF (relative or absolute), exactly as they gave it." }),
    question: Type.String({
        description: "What you need from the document — the specific content, explanation, or answer to extract and brief. " +
            "The reader sees NOTHING else of the lesson.",
    }),
});
/**
 * The per-call dispatch: create the job (idempotent by toolCallId), fire the
 * runner, and return the ack. Shared by all three tools — only kind differs.
 */
function dispatch(ctx, kind, toolCallId, ack, input) {
    const existing = ctx.jobStore.findJobByToolCallId(ctx.chatId, toolCallId);
    const job = existing ?? ctx.jobStore.createJob({ kind, chatId: ctx.chatId, toolCallId });
    if (!existing)
        ctx.spawn(job, input);
    return `Dispatched (job ${job.id}). ${ack}`;
}
const RESEARCH_ACK = "This call is fire-and-forget: continue your turn and keep teaching — do not wait, poll, or mention waiting. " +
    "The researched brief arrives as a new message when ready and the lesson resumes from it; cite its sources when you use them.";
const DEMO_ACK = "This call is fire-and-forget: continue your turn and keep teaching — do not wait, poll, or mention waiting. " +
    "The tested demo arrives as a new message when ready and is rendered in the lesson; teach with it then.";
const VISUAL_ACK = "This call is fire-and-forget: continue your turn and keep teaching — do not wait, poll, or mention waiting. " +
    "The verified figure arrives as a new message when ready and is rendered in the lesson; reference it then.";
const PDF_ACK = "This call is fire-and-forget: continue your turn and keep teaching — do not wait, poll, or mention waiting. " +
    "The document brief arrives as a new message when ready; weave it into the lesson and cite its pages.";
const RESEARCH_DESCRIPTION = "Dispatch a background web-research agent: fact verification, current data, or niche specifics you are not certain about. " +
    "The call is ASYNC and fire-and-forget — it resolves immediately and your turn continues; the research brief arrives later " +
    "as a new message and the lesson resumes from it. Cite the brief's sources when you use them. " +
    "NEVER use it for things you know cold, internal reasoning, or math.";
const DEMO_DESCRIPTION = "Dispatch a background sub-agent that BUILDS and headlessly TESTS an interactive teaching instrument — a single-file HTML " +
    "demo (parameter sweep, simulation, animation, sampling) rendered live in the lesson. Use it when the concept is DYNAMIC: " +
    "something to sweep, animate, or sample is better experienced than described. " +
    "The call is ASYNC and fire-and-forget — it resolves immediately and your turn continues; the tested demo arrives later " +
    "as a new message. Write a precise brief: concept, controls, interactions, style.";
const VISUAL_DESCRIPTION = "Dispatch a background sub-agent that hand-authors ONE precise SVG figure, renders it, LOOKS at the render, and iterates " +
    "until correct. Use it for exact spatial pictures auto-layout diagrams can't do: coordinate geometry, number lines, vectors, " +
    "function plots, physical layouts. For flows/relations/taxonomies write mermaid inline instead. " +
    "The call is ASYNC and fire-and-forget — it resolves immediately and your turn continues; the verified figure arrives later " +
    "as a new message.";
const PDF_DESCRIPTION = "Dispatch a background sub-agent that READS a learner-provided PDF on your behalf (triage, targeted extraction, visual page " +
    "reading for equations and diagrams) and returns a brief with page citations. Use it when the learner gives you a PDF path " +
    "and you need its CONTENT for the lesson. The call is ASYNC and fire-and-forget — it resolves immediately and your turn " +
    "continues; the brief arrives later as a new message. For quick looks at plain text or image files, use the read tool " +
    "directly instead of dispatching.";
/**
 * Per-request job tool registry: each tool closes over the composition root's
 * context (chatId + jobStore + the spawn seam), so concurrent chats never
 * share state. chat-handler wires it each turn; tests wire their own.
 *
 * The research tool drops from the registry when ctx.searchAvailable reports
 * no live engine (2026-09-20) — the teacher never sees it, so a keyless
 * server can't dispatch doomed research jobs. Jobs ALREADY in flight when
 * a key disappears still run to their honest failure (runner backstop).
 */
export function jobTools(ctx) {
    const searchOn = ctx.searchAvailable?.() ?? true;
    return {
        ...(searchOn && {
            research: {
                name: "research",
                label: "research",
                description: RESEARCH_DESCRIPTION,
                parameters: researchInputSchema,
                execute: serverExecute("research", researchInputSchema, (input, { toolCallId }) => dispatch(ctx, "research", toolCallId, RESEARCH_ACK, input)),
            },
        }),
        demo: {
            name: "demo",
            label: "demo",
            description: DEMO_DESCRIPTION,
            parameters: demoInputSchema,
            execute: serverExecute("demo", demoInputSchema, (input, { toolCallId }) => dispatch(ctx, "demo", toolCallId, DEMO_ACK, input)),
        },
        visual: {
            name: "visual",
            label: "visual",
            description: VISUAL_DESCRIPTION,
            parameters: visualInputSchema,
            execute: serverExecute("visual", visualInputSchema, (input, { toolCallId }) => dispatch(ctx, "visual", toolCallId, VISUAL_ACK, input)),
        },
        pdf: {
            name: "pdf",
            label: "pdf",
            description: PDF_DESCRIPTION,
            parameters: pdfInputSchema,
            execute: serverExecute("pdf", pdfInputSchema, (input, { toolCallId }) => dispatch(ctx, "pdf", toolCallId, PDF_ACK, input)),
        },
    };
}
//# sourceMappingURL=jobs.js.map