---
description: Worker implements, reviewer reviews, worker applies feedback
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "worker" agent to implement: $@ (it returns commits / files / decisions / build-test / not done)
2. Then, use the "reviewer" agent to review the commits and files from the previous step (use {previous} placeholder); it returns blocking / should-fix / nits
3. Finally, use the "worker" agent to fix the blocking and should-fix items from the review (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}.
