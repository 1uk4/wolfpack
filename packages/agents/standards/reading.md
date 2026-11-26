# Reading and investigating

Applies to every agent that reads code, data or logs. Required for the fast tier (scout, Haiku workers).
Goal: find the answer in few, small, bounded calls, the way the stronger models do.
Testing and commits are covered elsewhere: `testing.md`, `git.md`. UI checks: `verify-ui.md`. Not repeated here.

In the templates `$R` is the repo or worktree root, `$F` a file, `$DB` a SQLite file, `$LOG` a log file, `$DIR` a directory. Replace them with real paths (see the guard notes).

## 1. Rules

1. Start from the paths in your brief. Unsure where you are: `git rev-parse --show-toplevel`. Never `find /`, never loop over every repo, never guess roots like `~/code`.
2. Know the size before reading: `wc -l $F`, then slice (`sed -n 40,120p $F`, or the read tool with offset/limit). Read one range wide enough, once. Don't re-slice the same file four or five times. Never `cat` a large file.
3. Bound every output: `| head`, `| cut -c1-200`, `2>/dev/null`. Aim under about 5k characters per call.
4. To count, group, filter or pick fields (JSON, JSONL, SQLite, logs), write one short Python script instead of chaining grep/sed/cut/wc. Always `python3 -I`.
5. No here-documents: the bash guards reject `<<` ("here-documents are not supported"). Use `python3 -I -c "..."` (the string may span lines), or, if your agent can write files, write a script with the write tool and run `python3 -I /tmp/x.py`.
6. Never print secrets. Mask by key name; never `source` or `.` an `.env` file; show at most the length and the first 4 characters.
7. Databases: read-only, preferably on a copy. `sqlite3 -readonly $DB ...` or `sqlite3.connect('file:$DB?mode=ro', uri=True)`.
8. A pipeline that ends in `grep` exits 1 when nothing matched. That is "no match", not a failure. Don't retry it with a wider search; report "none".

## 2. Idioms by purpose

### Read JSON (top-level keys, one field)
```
python3 -I -c "import json;d=json.load(open('$F'));print(sorted(d)[:20])"
python3 -I -c "import json;d=json.load(open('$F'));print(json.dumps(d['key'])[:500])"
```
Mask secret-looking keys when dumping:
```
python3 -I -c "
import json,re
d=json.load(open('$F'))
def m(x):
    if isinstance(x,dict): return {k:('***' if re.search('key|token|secret|password',k,re.I) else m(v)) for k,v in x.items()}
    if isinstance(x,list): return [m(i) for i in x[:5]]
    return x
print(json.dumps(m(d))[:1500])"
```

### Count and group JSON
```
python3 -I -c "import json,collections as C;d=json.load(open('$F'))['items'];print(len(d),C.Counter((i.get('kind'),i.get('stage')) for i in d))"
```

### JSON from curl (pipe, don't save)
```
curl -s URL | python3 -I -c "import json,sys;d=json.load(sys.stdin);print(sorted(d[0]))"
curl -s -o /dev/null -w "%{http_code}\n" URL
```

### JSONL (look first, then count)
```
head -c 700 $F; wc -l $F
python3 -I -c "
import json,collections as C
c=C.Counter()
for l in open('$F'):
    try: r=json.loads(l)
    except Exception: continue
    c[r.get('type')]+=1
print(c.most_common(10))"
```
Always `try/except` per line: a truncated last line is normal.

### SQLite
```
sqlite3 -readonly $DB ".tables" ".schema entries"
sqlite3 -readonly $DB "select count(*) from entries" | cut -c1-300
sqlite3 -readonly $DB "select id,substr(title,1,60) from entries order by rowid desc limit 10"
```
JSON columns need Python:
```
python3 -I -c "
import sqlite3,json
c=sqlite3.connect('file:$DB?mode=ro',uri=True)
for id,j in c.execute('select id,data from entries limit 5'):
    print(id,sorted(json.loads(j)))"
```

### Logs
```
tail -n 25 $LOG | cut -c1-300
grep -E "pattern" $LOG | tail -6 | cut -c1-180
ssh -o BatchMode=yes -o ConnectTimeout=5 HOST "journalctl -u UNIT --since '1 hour ago' --no-pager | tail -30" | cut -c1-250
```

### Find files
```
find $DIR -maxdepth 4 -name 'X' -not -path '*/node_modules/*' 2>/dev/null | head
```

### Search code
```
grep -rn --include='*.ts' -E "a|b" $DIR | grep -v test | cut -c1-170 | head -10
grep -rln --include='*.ts' "symbol" $DIR | head
```
Locate with grep, then read only the lines around the hit.

### Slice a file
```
wc -l $F
sed -n 40,120p $F | cut -c1-200
```

### Git (read-only)
```
git -C $R log --oneline -20
git -C $R diff --stat A..B | tail -20
git -C $R show REF:path/to/file | sed -n 1,60p
git -C $R status --short | wc -l
```
(Workers: plain `git` inside the worktree; see section 3.)

### Aggregate
```
grep -o "pattern" $F | sort | uniq -c | sort -rn | head
```

### Config with masking
```
sed -E 's/((key|token|apiKey|secret)[^:=]*[:=] *).*/\1***/I' $F | head -60
```

### Processes and ports
```
ps -axo pid,etime,command | grep -E "x|y" | grep -v grep | cut -c1-140 | head -5
lsof -nP -iTCP -sTCP:LISTEN | awk '{print $1,$2,$9}' | sort -u | head
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:PORT/
```

### Compare
```
diff <(sed -n 1,80p A) <(sed -n 1,80p B) && echo SAME
diff -rq A B | head
```

### GitHub
```
gh pr view N --json title,state,mergeable,statusCheckRollup --jq '{title,state,mergeable}'
```

## 3. Guard notes

Read-only agents (scout, investigator, reviewer, researcher). Blocked, with the alternative:
- Heredocs: `python3 -I -c "..."`.
- `curl -o FILE`: pipe into python, or redirect `> /tmp/x.json` (only `/dev/null` and `/tmp/` are allowed redirect targets).
- `source` / `.`: read the file with `sed`/python and mask; never load it into the shell.
- `cp`, `rm`, `ln`, `setfacl`, installs: don't modify; read in place.
- `git fetch`, `git checkout`: use `git show REF:path` and `git diff A..B`.
- Command names built from variables (`$R/main.cjs`): write the real path.
- Redirects to anywhere except `/dev/null` or `/tmp/`.

Workers (plain bash):
- Heredocs are blocked here too.
- Run tests only with `wolfpack test run <file>`.
- No `git worktree`, `git stash`, `git cherry-pick`, `git -C`, `git -c`, `git fetch`. Run `git` in the worktree you were given.
- Edit with the edit/write tools, not `sed -i`.

Everyone: each bash call is limited to 60 s. Bound searches (`-maxdepth`, a specific directory); split long jobs.

## 4. Pitfalls seen in fast-tier runs

- `find /` and unbounded `find ~` timed out at 60 s. Search the directory the brief names.
- A loop that `curl -o` saved files was blocked. Pipe into python instead.
- `source .env` was blocked, and the fallback then used a wrong value. Read the file and mask; ask if a value is missing.
- Guessed repo roots (`~/code/...`) that did not exist. Use the brief's path or `git rev-parse --show-toplevel`.
- The same file sliced five times in different ranges. Check `wc -l`, read once.
- Whole-file `cat` of a large file filled the context. Slice and cut.
