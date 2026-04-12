---
name: task-manager
description: Create, update, complete, and query tasks in the vault task system (TaskNotes). Use when user says "add task", "new task", "mark done", "what's next", "reprioritize", or when processing check-in responses. Also use when creating tasks from GitHub issues or conversation context.
---

# Task Manager (TaskNotes)

All tasks are markdown files with YAML frontmatter, managed by the TaskNotes Obsidian plugin. Reference: `TaskNotes/Task Dictionary.md`

## Task Location
- All tasks: `TaskNotes/Tasks/`
- Views: `TaskNotes/Views/` (.base files — do not edit)
- Dictionary: `TaskNotes/Task Dictionary.md`
- Old archived tasks: `tasks-archive/` (read-only reference)

## Task Schema

Every task file follows this format:

```yaml
---
tags:
  - task
  - snapjack              # project tag (optional, for cross-cutting filters)
  - launch-blocker         # scope tag (optional)
title: League invite system
status: open
priority: critical
due: 2026-03-23
scheduled: 2026-03-23
contexts:
  - "@dev"
projects:
  - "[[Snapjack MOC]]"
  - "[[Leagues]]"
timeEstimate: 180
---

# League invite system

## Description
Build league invite flow...

## Notes

## Subtasks
```

## Field Reference

### Status (required)
| Value | Meaning |
|-------|---------|
| `none` | Unclassified |
| `open` | Not started |
| `in-progress` | Actively working |
| `done` | Completed |
| `cancelled` | Won't do |

### Priority (required)
| Value | When |
|-------|------|
| `none` | Unclassified |
| `low` | Backlog, nice to have |
| `normal` | This sprint, can wait |
| `high` | This week, important |
| `critical` | Launch blockers, due today/tomorrow |

### Tags (required: `task`)
Always include `task`. Add scope tags as needed:
- `snapjack` — any Snapjack work
- `home-lab` — homelab project
- `launch-blocker` — must ship before App Store
- `personal` — personal/life tasks

### Contexts (required — pick one)
The *what type* of work:
| Context | When |
|---------|------|
| `@dev` | Coding, features, debugging |
| `@life` | Bills, errands, personal admin |
| `@fitness` | Workouts, training, health |
| `@career` | Resume, portfolio, job search, articles |
| `@infra` | Server setup, DevOps, homelab |
| `@design` | UI/UX, icons, screenshots |

### Projects (required — use nested pattern)
Wikilinks to vault notes. Use **parent + system** for nested projects:
```yaml
projects:
  - "[[Snapjack MOC]]"    # always include parent
  - "[[Leagues]]"          # specific system
```

**Snapjack systems:** `[[Leagues]]`, `[[Auth & Users]]`, `[[iOS]]`, `[[Settlements]]`, `[[Rating]]`, `[[Game Tracking]]`, `[[Legal]]`, `[[Notifications]]`, `[[Social]]`, `[[Stats & Analytics]]`, `[[Marketing]]`

**Other projects:** `[[Home Lab MOC]]`, `[[Life Admin]]`, `[[Job Search]]`, `[[Personal Website]]`, `[[F-150 Overview]]`, `[[Fitness MOC]]`, `[[Dotfiles MOC]]`

Non-Snapjack tasks use a single project (no parent needed):
```yaml
projects:
  - "[[Life Admin]]"
```

### Time Estimate
`timeEstimate` in **minutes** (number, not string):
- 30min → `timeEstimate: 30`
- 2h → `timeEstimate: 120`
- Quick task → `timeEstimate: 5`

### Dates
- `due` — hard deadline (ISO date: `2026-03-23`)
- `scheduled` — when to work on it (ISO date)
- Both optional. Set `due` for deadlines, `scheduled` for calendar planning.

## Creating a Task

1. Determine type from context → pick context and projects
2. Create file in `TaskNotes/Tasks/`
3. File name = task title (e.g., `League invite system.md`)
4. Fill frontmatter per schema above
5. Body: `# Title` + Description/Notes/Subtasks sections

### Workout file naming
Workouts use date prefix: `YYYY-MM-DD Session Name.md`
Example: `2026-03-21 Lower Body.md`

## Completing a Task

1. Set `status: done`
2. That's it — TaskNotes handles the rest (auto-archive if configured)

Do NOT move files between folders. Status field drives everything.

## Updating a Task

Edit the frontmatter directly. Common updates:
- Change status: `status: in-progress`
- Change priority: `priority: high`
- Add due date: `due: 2026-03-25`
- Reschedule: `scheduled: 2026-03-26`

## Logging a Workout

Triggered by: "log run", "log workout", "just finished lifting", etc.

### Running Questionnaire
1. Distance?
2. Time / average pace?
3. Effort (1-10)?
4. Heart rate data? (optional)
5. How did it feel? Any pain/soreness?
6. Terrain? (road/trail/track/treadmill)
7. Indoor or outdoor?
8. On plan or deviation?

### Lifting Questionnaire
1. Which session? (upper push / upper pull / lower / other)
2. Go through each exercise: weight, reps per set
3. Total duration?
4. Effort (1-10)?
5. Any soreness or pain?
6. Progressive overload from last session?
7. On plan or deviation?

### Workout Task Format

```yaml
---
tags:
  - task
  - fitness
title: Lower Body — Week 1
status: done
priority: normal
due: 2026-03-20
contexts:
  - "@fitness"
projects:
  - "[[Fitness MOC]]"
timeEstimate: 50
effort: 7
distance_mi: 0
total_sets: 15
total_reps: 180
total_volume_lbs: 12500
soreness_notes: "Quads sore from yesterday"
planned_vs_actual: "Modified — swapped RDL for leg curl"
---
```

⚠️ **No nested YAML arrays in frontmatter.** Exercise details go in the body as a markdown table. Frontmatter has scalar aggregates only.

### Volume Calculation
`total_volume_lbs = sum(weight × reps)` across all sets of all exercises.

### Body Structure (Lifting)
```markdown
# YYYY-MM-DD Session Name

## Summary
Brief session overview.

## Exercises
| Exercise | Set 1 | Set 2 | Set 3 |
|----------|-------|-------|-------|
| Squat | 8×135 | 8×135 | 8×135 |

## Notes
How it felt, observations.

## Plan Comparison
**Planned:** ...
**Actual:** ...
```

### Body Structure (Running)
```markdown
# YYYY-MM-DD Run Type Distance

## Summary
Brief run overview.

## Splits (if available)
| Mile | Pace | HR |
|------|------|----|

## Notes
How it felt, observations.
```

## Querying Tasks

Users can ask "what's next", "show critical tasks", "what's due this week". Read from `TaskNotes/Tasks/` and respond. Summarize naturally — don't recite raw frontmatter.

## Scheduling to Calendar

When scheduling tasks to Google Calendar:
```
sudo -u hal-admin /home/hal-admin/scripts/gcal.sh add-event "TITLE" "START" "END" "DESCRIPTION"
sudo -u hal-admin /home/hal-admin/scripts/gcal.sh move-event <id> "START" "END"
```
Set task `status: in-progress` and `scheduled: YYYY-MM-DD` after scheduling.

## Daily Logs

Daily session logs go in `memory/daily/YYYY-MM-DD.md` (separate from tasks):
```yaml
---
uplink: "[[Daily Log]]"
date: YYYY-MM-DD
---
```

## Key Differences from Old System
- Tasks stay in ONE folder (`TaskNotes/Tasks/`) — no backlog/completed split
- Status drives lifecycle, not folder location
- `uplink` is now `projects` (supports multiple values)
- Priority is `low/normal/high/critical` not `p1/p2/p3`
- Status is plain string not wikilink emoji
- Time estimates are minutes (number) not string
- Type is now `contexts` + `tags` not a separate field
