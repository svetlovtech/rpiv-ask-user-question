# rpiv-ask-user-question — local fork

Structured questionnaire tool for the Pi coding agent (typed options instead of free-form replies).

## Upstream

- npm package: `@juicesharp/rpiv-ask-user-question`
- repo: https://github.com/juicesharp/rpiv-mono (monorepo, this package lives in `packages/rpiv-ask-user-question`)
- Pi loads THIS fork (not the npm package): `~/.pi/agent/settings.json` → `/home/dev/pi-forks/rpiv-ask-user-question`

## Baseline

- Fork is based on `@juicesharp/rpiv-ask-user-question@2.6.0` (npm copy snapshot).
- Baseline commit: `fdda6a1`.
- See `.upstream-version`.

## Local changes (ours, on top of baseline)

| Area | Files | Why |
|---|---|---|
| Telegram answer correlation | `ask-user-question.ts`, `events.ts` | Propagate `toolCallId` through the ask-user prompt event so `pi-telegram-bridge` can match a Telegram answer back to the in-flight TUI dialog. |

## Syncing upstream updates

```bash
../sync-upstream.sh
```

Manual reference:

```bash
git remote add upstream https://github.com/juicesharp/rpiv-mono.git  # once
git fetch upstream
git log upstream/main --oneline -- packages/rpiv-ask-user-question
git diff fdda6a1 upstream/main -- packages/rpiv-ask-user-question
```

Rules:
- `ask-user-question.ts` and `events.ts` are locally modified — upstream changes there need a manual merge.
- After syncing, update `.upstream-version` and commit.
