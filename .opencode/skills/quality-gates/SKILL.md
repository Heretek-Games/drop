---
name: quality-gates
description: Use before committing or when asked to "run the gates", "check everything", or verify a change compiles/lints/tests. Lists the exact local commands for each Drop workspace and the hook behaviour.
---

# Local quality gates

Run from the repository root unless noted.

## Fast (staged-file hooks)

```sh
pnpm exec lefthook run pre-commit --all-files
```

Runs prettier, eslint (server), ast-grep, shellcheck, hadolint, actionlint, ruff, typos and gitleaks. Tools come from mise; install with `mise install`.

## Before pushing

```sh
pnpm exec lefthook run pre-push --all-files
```

Runs server typecheck + lint, desktop/base/promo/docs lint, `scripts/clippy-changed.sh` (cargo fmt + clippy), golangci-lint and a report-only knip.

## Per-workspace commands

```sh
pnpm -C server run lint && pnpm -C server run typecheck && pnpm -C server run test
pnpm -C desktop/main run lint && pnpm -C desktop/main run typecheck
pnpm -C libraries/base run lint
pnpm -C sites/promo run lint
pnpm -C sites/docs run lint
```

## Single edited file

```sh
scripts/agent-quality.sh <path>
```

Formats and auto-fixes one file (prettier, workspace eslint --fix, ruff, shfmt, cargo fmt, gofmt). The opencode plugin and the Claude/Cursor PostToolUse hooks call it automatically after edits.

## SonarCloud

Remote analysis runs on push; see the `sonar-triage` skill for the CLI workflow.
