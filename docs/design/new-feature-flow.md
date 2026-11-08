# New feature flow from the console (work-wolfpack-ZaJzpoD)

The grilling → spec → tickets flow already lives entirely in the prompts plus the task tools. `/task new` in a pi session
sends `newWorkPrompt()` as a user message; the agent then runs the stages itself. "Start from the console" therefore only
means: send that same wolf-resolved message into a wolf thread. No new engine, no new state store.

## Stages and what moves them
| Stage | Moved by |
|---|---|
| new-work (route the idea, pick a domain) | the first turn: the wolf-resolved `new-work` prompt, plus the owner's optional one-line idea |
| grilling | the agent, following `grilling` (inlined in `new-work`); the owner replies in the thread (ask-user cards or text) |
| spec | the agent, `to-spec`, when grilling is done (its decision, not a command) |
| tickets | the agent, `to-tickets`; it creates the work items with `task_create` |

The stage protocols are not a state machine in code. Nothing in wolfd or the console advances them.

## Where state lives
- The **thread** (the wolf's home thread transcript) holds the conversation: that is the flow's only flow-state.
- The **work items** the agent creates carry the durable result (feature, tasks, stages); the existing binding rules apply.
- No new file, table or thread kind. Persisted by existing means: the transcript and the work items.

## How a thread is marked
It is not. The start request answers `{threadId, disposition, messageId}`; the console opens that thread. The marker is the
first message of the turn: the new-work prompt text itself. (A dedicated thread kind was rejected: `feature` threads
need an existing work item id, and this flow creates the item; a new kind touches every schema and view.)

## Resolution of the prompt
`POST /v1/wolves/:name/new-feature {idea?}` is wolf-scoped, so a remote wolf is reached through the hubd relay like
`/prompts` and `/settings`. wolfd resolves `newWorkPrompt(domains, wolfHome)` itself, on the wolf's host: its overrides at
`<wolf-home>/agent/prompts/{new-work,grilling,to-spec,to-tickets}.md` win over repo defaults. `domains` are that wolf's
subscribed domains (KB base of the wolf). The console never reads or builds prompt text; it sends the wolf name and the idea.
The idea is appended after the prompt as `\n\nThe idea: <idea>`. The text goes to the wolf's home thread
with `whenBusy: "reject"` semantics: a busy home answers 409 `busy` and the console says so.
