# rpiv-ask-user-question — local fork

Structured questionnaire tool for the Pi coding agent (typed options instead of free-form replies).

## Upstream

- npm package: `@juicesharp/rpiv-ask-user-question`
- repo: https://github.com/juicesharp/rpiv-mono (monorepo, this package lives in `packages/rpiv-ask-user-question`)
- Pi loads THIS fork (not the npm package): `~/.pi/agent/extensions/svetlovtech-rpiv-ask-user-question`
- GitHub mirror (origin): https://github.com/svetlovtech/rpiv-ask-user-question (private, standalone repo). Push: `git push origin master`.

> Note: the old standalone repo https://github.com/juicesharp/rpiv-ask-user-question is
> **moved/read-only** (shows a "this repository has moved to rpiv-mono" notice).
> The live upstream is `juicesharp/rpiv-mono` — do NOT sync from the old repo.

## Baseline

- Fork is based on `@juicesharp/rpiv-ask-user-question@2.9.0` (rpiv-mono `packages/rpiv-ask-user-question` tree).
- Baseline commit: `5dcad51c`.
- See `.upstream-version`.

## Local changes (ours, on top of baseline)

| Area | Files | Why |
|---|---|---|
| Telegram answer correlation | `ask-user-question.ts`, `events.ts` | Propagate `toolCallId` through the ask-user prompt event and expose `pi-telegram-bridge:resolve-ask` so `pi-telegram-bridge` can match a Telegram answer back to the in-flight TUI dialog. |
| Outcome summary in blocked event | `ask-user-question.ts`, `events.ts` | Closing `rpiv:ask-user:blocked` carries `summary` (one-line outcome, RU) + `perQuestion` answer texts for external mirrors. |
| Single-option questions | `tool/types.ts` | `MIN_OPTIONS` 2 → 1: a single option acts as an acknowledge button. Vendored tests (`tool/types.test.ts`, `ask-user-question.execute.test.ts`) assert the fork contract. |
| Standalone test run | `vitest.local.config.mts`, `vitest.setup.local.mts` | Lets `npx vitest run` work outside the monorepo (cleans the config file between tests). |

## Syncing upstream updates

> **Runtime deps are REQUIRED for Pi to load the extension.** 2.9.0 added
> `@juicesharp/rpiv-config` and `@juicesharp/rpiv-i18n` as runtime deps —
> keep them in `node_modules/` (installed copy may be refreshed via
> `npm pack @juicesharp/rpiv-config@<ver>` + unpack into `node_modules/@juicesharp/`;
> `@earendil-works/*` and `typebox` are provided by Pi / already vendored).

```bash
git fetch upstream
UP=$(git rev-parse upstream/main)
git checkout -b sync-2xx 4c4d2e88        # or the previous baseline import commit
git rm -rq .
git archive upstream/main packages/rpiv-ask-user-question | tar -x --strip-components=2
git checkout HEAD -- .gitignore .upstream-version AGENTS.md
git add -A && git commit -m "upstream: @juicesharp/rpiv-ask-user-question <ver> (rpiv-mono ${UP:0:9})"
git merge master                          # 3-way: upstream tree vs our features
# resolve ask-user-question.ts manually — our features are NOT upstream
git checkout master && git merge --ff-only sync-2xx && git push origin master
```

Standalone tests (after syncing node_modules:
`cp -r <rpiv-mono-checkout>/packages/test-utils node_modules/@juicesharp/rpiv-test-utils`):

```bash
npx -y vitest@4.1.11 run --config vitest.local.config.mts --testTimeout=15000
```

Rules:
- `ask-user-question.ts` and `events.ts` carry our features — upstream changes there need a MANUAL re-apply (upstream has neither `toolCallId` correlation nor summary/perQuestion).
- Vendored tests assert the fork contract where it intentionally diverges (MIN_OPTIONS=1, event payloads) — keep the `// fork:` comments.
- After syncing, update `baselineVersion`/`baselineCommit` in `.upstream-version` and commit.
