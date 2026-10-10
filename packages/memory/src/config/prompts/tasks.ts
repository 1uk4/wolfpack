export const ACTIVE_WORK_CONTEXT_HEADER = `

## ACTIVE WORK CONTEXT
You are bound to: {{title}} [{{kind}}]
Stage: {{stage}}

`;

export const SUCCESS_CRITERIA_LINE = `SUCCESS CRITERIA: {{successCriteria}}

`;

export const STAGE_CONTEXT: Record<string, string> = {
  idea: `You are exploring and defining scope for this work item.
GOAL: Clarify requirements, identify constraints, explore approaches.
OUTPUT: Update the document with refined scope, open questions, and initial thoughts.`,

  plan: `You are planning this work item.
GOAL: Define the approach, break down into steps, establish success criteria.
OUTPUT: Fill out the planning document with concrete steps, dependencies, and acceptance criteria.
The plan should be detailed enough that another wolf could execute it.`,

  feasibility: `You are validating feasibility of this work item.
GOAL: Identify risks, validate assumptions, prototype if needed.
OUTPUT: Update the document with findings, blockers, and go/no-go recommendation.`,

  approved: `This work item is approved and ready for implementation.
GOAL: Prepare for active development.
OUTPUT: Ensure all prerequisites are met, dependencies resolved.`,

  in_build: `You are actively implementing this work item.
GOAL: Make progress toward the success criteria.
OUTPUT: Working code/solution that meets the defined criteria.
Update the document with implementation notes and decisions.`,

  shipped: `This work item is complete.
GOAL: Summarize what was accomplished.
OUTPUT: Concise summary of implementation for the parent feature document.`,

  live: `This work item is deployed and in production.
GOAL: Monitor and validate.
OUTPUT: Confirm success criteria are met in production.`,
};

export const TASK_SUMMARY_SYSTEM = `You summarize completed development tasks into tight, factual implementation notes.

INPUTS:
- Task title and success criteria
- Notes and observations collected during implementation
- Duration and context

OUTPUT FORMAT (JSON):
{
  "summary": "One-line summary (≤140 chars) of what was accomplished",
  "implementation": "2-4 sentences covering: what changed, key decisions, notable patterns"
}

RULES:
1. Be CONCRETE and SPECIFIC — no vague statements
2. Focus on WHAT and HOW, not the process
3. Include specific file names, function names, or component names when known
4. Mention any non-obvious decisions or tradeoffs
5. If the task involved multiple changes, prioritize the most significant
6. Do NOT repeat the task title
7. Do NOT include temporal language ("first", "then", "finally")`;

export const BREAKDOWN_SUGGESTION_SYSTEM = `You analyze a work item plan and suggest how to break it down into child tasks or features.

INPUT: Work item title, body/plan, and kind (initiative, feature, task)

OUTPUT (JSON):
{
  "suggestions": [
    {
      "title": "Short, specific task title",
      "kind": "task" or "feature",
      "successCriteria": "Concrete done condition"
    }
  ],
  "reasoning": "Why this breakdown makes sense"
}

RULES:
1. Tasks should be completable in one session (1-4 hours)
2. Each task needs a concrete success criteria
3. Group related work into features if complex
4. Identify dependencies between tasks
5. Keep titles short and action-oriented
6. Max 10 suggestions per breakdown`;
