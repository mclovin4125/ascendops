---
name: local-version-control
description: "Daily git snapshots of agent workspace changes. Stages files with safety checks, reviews diff for PII, commits with descriptive message. Never pushes automatically."
triggers: ["auto-commit", "git snapshot", "commit changes", "version control"]
---

# Local Version Control

Daily snapshot of all agent workspace changes. Runs via auto-commit.sh with a two-layer safety review.

## Scope (worktree-aware)

This skill snapshots **agent state files only** - `memory/`, `MEMORY.md`, `GOALS.md`, `config.json`, and the agent dir's tracked-by-canonical files - into a dedicated git repo at `${CTX_FRAMEWORK_ROOT}/orgs/${CTX_ORG}`, NOT the framework root itself. `orgs/` is gitignored at the framework root by design (it's user-created org data, not framework code - it must never end up in the framework's own git history, which can sync with a public/upstream remote), so committing there would silently no-op forever. `cortextos bus auto-commit --dir <path>` targets an explicit directory and auto-initializes a git repo there on first use - self-healing, no manual `git init` needed. Worktree code work is NOT auto-committed here - it ships via the PR workflow (feature branch on the agent's worktree + `gh pr create`). Every bash block in this skill starts with `cd "${CTX_FRAMEWORK_ROOT:?CTX_FRAMEWORK_ROOT must be set}/orgs/${CTX_ORG:?CTX_ORG must be set}"` to guarantee correct cwd; each shell invocation in an agent session is a fresh shell. Running this skill from a per-agent worktree, or against the framework root, would either commit to the wrong tree or miss the canonical agent state files entirely.

## When to Run

- Daily cron (configured via `cortextos bus add-cron`)
- After major agent work sessions
- Before any destructive operations

## Workflow

### Step 1: Run auto-commit

```bash
RESULT=$(cortextos bus auto-commit --dir "${CTX_FRAMEWORK_ROOT:?CTX_FRAMEWORK_ROOT must be set}/orgs/${CTX_ORG:?CTX_ORG must be set}")
```

This stages files with safety checks:
- Blocks .env files and credentials
- Blocks files over 10MB
- Blocks binary/temp files
- Respects .gitignore rules
- Initializes the org-state git repo on first run if it doesn't exist yet

### Step 2: Review the staged diff

```bash
cd "${CTX_FRAMEWORK_ROOT:?CTX_FRAMEWORK_ROOT must be set}/orgs/${CTX_ORG:?CTX_ORG must be set}"
git diff --cached
```

Check for:
- PII: names, emails, phone numbers in memory files
- Secrets: tokens, API keys, passwords
- Large diffs that look wrong
- Files that should not be committed

If anything looks sensitive, unstage it:
```bash
cd "${CTX_FRAMEWORK_ROOT:?CTX_FRAMEWORK_ROOT must be set}/orgs/${CTX_ORG:?CTX_ORG must be set}"
git reset HEAD <file>
```

### Step 3: Commit

Generate a descriptive commit message summarizing what changed:
```bash
cd "${CTX_FRAMEWORK_ROOT:?CTX_FRAMEWORK_ROOT must be set}/orgs/${CTX_ORG:?CTX_ORG must be set}"
git commit -m "daily: <summary of changes>"
```

### Step 4: Do NOT push

Auto-commit never pushes. The user or orchestrator decides when to push.

## Config

Requires `ecosystem.local_version_control.enabled: true` in config.json.

## Safety

- Never commits .env files
- Never commits files matching credential patterns
- Always reviews diff before committing
- Never pushes automatically
