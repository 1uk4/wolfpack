/**
 * Test-only question-tool registry. The console's assistant agent ships with
 * NO tools; the question family (quiz / explain / ask_user_question) is
 * client-answered shell machinery — the dock, the answer events, dismissals,
 * steering — and these tools let tests drive that machinery with a scripted
 * model. They mirror the retired teaching tools' mechanics (validation at
 * the call boundary, the "question posed" terminate placeholder, the
 * universal argument heal) minus the plan-tree nodeId check.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { healToolRecord } from "../../src/agent/tools/heal.ts";
import { invalidInputResult, questionResult } from "../../src/agent/tool-execute.ts";
import {
	askInputSchema,
	askOptionProblems,
	explainInputObject,
	explainInputProblems,
	parseOptionsIfString,
	quizInputObject,
	quizInputProblems,
} from "../../src/core/question-core.ts";

function prepareQuestionArguments<T extends object>(args: unknown): T {
	if (args && typeof args === "object" && !Array.isArray(args)) {
		const o = args as { options?: unknown };
		if (typeof o.options === "string") {
			const parsed = parseOptionsIfString(o.options);
			if (parsed !== o.options) return { ...o, options: parsed } as T;
		}
		return o as T;
	}
	return args as T;
}

export const quizTool: AgentTool<typeof quizInputObject> = {
	name: "quiz",
	label: "quiz",
	description: "Ask the user a graded question.",
	parameters: quizInputObject,
	prepareArguments: prepareQuestionArguments,
	executionMode: "sequential",
	execute: async (_toolCallId, input) => {
		const problems = quizInputProblems(input);
		if (problems.length > 0) return invalidInputResult("quiz", problems);
		return questionResult();
	},
};

export const explainTool: AgentTool<typeof explainInputObject> = {
	name: "explain",
	label: "explain",
	description: "Ask the user to explain something in their own words.",
	parameters: explainInputObject,
	prepareArguments: prepareQuestionArguments,
	executionMode: "sequential",
	execute: async (_toolCallId, input) => {
		const problems = explainInputProblems(input);
		if (problems.length > 0) return invalidInputResult("explain", problems);
		return questionResult();
	},
};

export const askTool: AgentTool<typeof askInputSchema> = {
	name: "ask_user_question",
	label: "ask_user_question",
	description: "Ask the user a single ungraded question.",
	parameters: askInputSchema,
	prepareArguments: prepareQuestionArguments,
	executionMode: "sequential",
	execute: async (_toolCallId, input) => {
		const problems = askOptionProblems(input.options ?? []);
		if (problems.length > 0) return invalidInputResult("ask_user_question", problems);
		return questionResult();
	},
};

/** The default question registry (quiz + ask), healed like every registry. */
export function questionTools(): Record<string, AgentTool<any>> {
	return healToolRecord({ quiz: quizTool, ask_user_question: askTool });
}

/** The free-recall registry (explain + ask). */
export function freeRecallTools(): Record<string, AgentTool<any>> {
	return healToolRecord({ explain: explainTool, ask_user_question: askTool });
}
