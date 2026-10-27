You are running a guided acceptance test of the Wolfpack Console with me, the operator. Work through the tests below in order, one at a time. You drive; I act and observe. Keep your messages short.

Ground rules
- Before anything else, check you are a SANDBOXED dev wolf: your den and work store must be under ~/wolves/dev/sandbox (check WOLF_DEN and your work endpoint). If you are not sandboxed, stop and tell me; do not run tests 9 or 10.
- Track the run with show_checklist, objectId "console-acceptance", title "Console acceptance". It has one item per test below, all "todo" at the start. Revise it (same objectId, full list every time) as each test starts ("doing") and ends ("done" when it passed, "skipped" when it failed or was skipped, and put a short reason in the item note).
- After each test, ask me with ask_user_question whether it passed: a confirm field ("Passed", "Failed") plus an optional free-text field "What did you see?". Record my answer.
- Never ship, release or write anything outside the sandbox.

Tests

1. Pinned checklist
   Your first show_checklist call should appear as a floating card at the top of the thread, collapsed, showing "Console acceptance · 0/13" and the item in progress as a subtitle, with NO progress bar yet (the bar appears once the first item is done). Ask me to confirm: it is collapsed by default; clicking it expands the full list in place; clicking again (or Esc while inside it) collapses it; it stays put while I scroll.

2. Question card: every field type
   Raise ONE card with questions[] containing:
   - free text "Your name" (required);
   - single choice "Favourite colour" with options Red (red), Green (green), Blue (blue), allowOther;
   - multi choice "Pick toppings" with options Cheese, Olives, Basil, Mushroom, allowOther, and maxSelect 3 (the ask_user_question parameter);
   - confirm "Ready to continue?" with labels "Yes, go" / "Not yet";
   - free text "Anything else?" with optional: true.
   I will leave "Anything else?" blank and submit. Pass if Submit was enabled with that optional field blank, the indicators were large and the whole row was clickable, and your received answers show the single choice as "Label (value)", the multi as labels, the confirm as yes/no with its label, and "Anything else?" as "(skipped)". Tell me exactly what text you received.

3. Required rule
   Raise a card with a REQUIRED multi choice (no min) and a required free text. Ask me to try to submit with nothing filled in. Pass if Submit stays disabled until both have an answer, and the multi shows "Pick at least 1" (not a red error before I touch it).

4. Conditional and stepped card
   Raise a stepped card (steps) with: step 1 holds free text "Project name" (required) and single choice "Strategy" (By folder = by-folder, By pattern = by-pattern, allowOther); step 2 holds single choice "Depth" (1, 2, 3) with showIf Strategy equals by-folder, plus free text "Notes" (optional). So a text field sits on a step BEFORE the last one. I will fill "Project name", pick By pattern, and press Enter in a single-line text box (the "Other…" box under Strategy, after typing a word in it) to go to the next step; in the multi-line free-text box Enter only adds a line. Pass if Depth never appears, Back/Next work, Enter in the single-line box moves to the next step (and does nothing if the step is incomplete), Submit only appears on the last step, and you receive no Depth answer.

5. Skip and supersede
   a) Raise a simple question card; I will press "Skip question". Pass if the card shows a "Skipped" badge and you were told I skipped it.
   b) Raise another simple question card; instead of answering I will type a normal chat message. Pass if that card shows "Superseded" and you were told it was superseded.

6. Needs you
   Raise a question card and tell me to look at the thread list in the sidebar before answering. Pass if this thread shows the "needs you" dot while the card waits and the dot clears after I answer. Then ask me (confirm) whether I want to test the OS notification: if yes, tell me to switch to another app, wait 5 seconds, raise a card, and ask me afterwards whether a notification appeared and clicking it opened this thread. (Desktop app: OS notification. Browser: only if "Notify me" is enabled in the sidebar footer.)

7. Live objects
   a) show_decision objectId "db-choice": options Postgres (pg) / SQLite (sqlite), chosen pg, rationale "Concurrent writers". Then revise the same objectId to chosen sqlite with rationale "Single writer after all". Pass if one card updated in place and shows "updated 1 time".
   b) show_graph objectId "plan": 5 nodes (Design, Build API, Build UI, Test, Release) with dependencies Build API and Build UI depend on Design, Test depends on both builds, Release depends on Test; all todo. Then revise with Design done and Build API doing. Pass if the graph lays out left to right by dependency and updates in place.
   c) show_checklist with a NEW objectId "mini" (2 items), then go back to revising "console-acceptance". Pass if the pinned card switched to "mini" and then back to "Console acceptance" (the most recently updated checklist wins).
   d) Ask me to press the × on the pinned card, then revise "console-acceptance" once more. Pass if it stays dismissed after that revision and after a page reload; then tell me it will come back only for a different checklist id.

8. Images
   a) Ask me to paste a screenshot (anything with clear content). Describe it. Pass if your description matches.
   b) In this same thread, ask me to paste a SECOND, different image. Describe it. Pass if you see the second image (not a placeholder).
   c) Ask me to attach a large retina screenshot (over 2000 px wide) and then use read on its attachment path. Pass if read returns the image (shrunk) and you can describe it.

9. Ship confirmation (sandbox only)
   Create a throwaway task in the sandbox (domain of your choice, title "Acceptance throwaway", success criteria "none"), bind it, then call task_done. Pass if a "Ship / Not yet" card appears and nothing ships until I answer. I will press "Not yet" first: check it did not ship. Then call task_done again and I will press Ship: check it shipped.

10. Crawl (sandbox KB only)
   Run crawl_start on a small folder I name (ask me; suggest your own workspace docs). Pass if the interview arrives as one stepped card, the depth question only shows for "By folder", and crawl_plan uses my answers. Approve the plan, then crawl_run: pass if the run card offers concurrency (and resume/fresh if there are earlier runs) and the run proceeds in the background; check it with crawl_status. Only if crawl_status shows it finished and I confirm, call crawl_release: pass if I get a dry-run summary and a confirm card, and nothing is released unless I confirm. Release to the sandbox only.

11. Dictation (needs a Deepgram key in Settings)
   Ask me to: dictate a sentence into the composer with ⌘D or the bar under the message box; then, in a question card you raise with a free-text field and a multi choice with allowOther, use the small mic inside each text field. Pass if text lands in the right field, Enter while dictating during a running turn sends instead of stopping it, and no error appears in the browser console.

12. Composer and history
   Ask me to reload the page. Pass if every card keeps its state (answered, Skipped, Superseded), images show as thumbnails, the decision/graph/checklist cards show their latest versions, and the pinned card state is as I left it.

13. Errors
   Ask me whether the browser dev console showed the warning "Can't perform a React state update on a component that hasn't mounted yet" at any point. Pass if no.

Final report
When all tests are done, set every item's final state in "console-acceptance", then reply with a table: test number, name, PASS/FAIL/SKIPPED, and one line of what I saw for each failure. End with the total passed out of 13.
