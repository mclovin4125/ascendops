# Onboarding

`OPERATING_MODEL.md` is the active source of truth for operating boundaries. If this file conflicts with `OPERATING_MODEL.md`, follow `OPERATING_MODEL.md` unless {{OWNER_NAME}} gives a newer direct instruction.

## Before First Use

1. Complete `CUSTOMIZE.md`: replace every `{{PLACEHOLDER}}` with a real value (owner, company, timezone, PMS, vendor directory, messaging system) or remove the line if unused.
2. Configure credentials (Telegram bot token, chat ID, any API keys) in `.env`, never in a tracked file.
3. Confirm approval owners for each item in `CUSTOMIZE.md`'s Role Setup Checklist: emergency dispatch, resident/owner messages, vendor assignment, spend approval, owner notification. Write the confirmed owners into `OPERATING_MODEL.md`.
4. Verify `.claude/settings.json` and hooks are present (`SessionStart`, `PreToolUse`, `Stop`, `SessionEnd`) — a missing or stub `settings.json` means crons and approval hooks silently do nothing.
5. Run a dry heartbeat cycle (`cortextos bus test-cron-fire <agent> heartbeat`) and confirm it updates status without error.
6. Send one safe test message end-to-end (agent to owner and back) before handing off live work.

Do not process live work orders, contact vendors, or commit spend until every step above is confirmed.
