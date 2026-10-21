---
description: Full implementation workflow - scout gathers context, planner creates plan, worker implements
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "scout" agent to find all code relevant to: $@ (it returns findings / files with line numbers / open questions)
2. Then, use the "planner" agent to create an implementation plan for "$@" using the context from the previous step (use {previous} placeholder); it returns plan / files / risks
3. Finally, use the "worker" agent to implement the plan from the previous step (use {previous} placeholder); it returns commits / files / decisions / build-test / not done

Execute this as a chain, passing output between steps via {previous}.
