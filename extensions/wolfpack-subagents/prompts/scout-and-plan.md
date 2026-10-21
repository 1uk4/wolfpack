---
description: Scout gathers context, planner creates implementation plan (no implementation)
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "scout" agent to find all code relevant to: $@ (it returns findings / files with line numbers / open questions)
2. Then, use the "planner" agent to create an implementation plan for "$@" using the context from the previous step (use {previous} placeholder); it returns plan / files / risks

Execute this as a chain, passing output between steps via {previous}. Do NOT implement - just return the plan.
