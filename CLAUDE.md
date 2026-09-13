# Drop — Claude Code guide

Self-hosted game distribution platform (polyglot monorepo).

> **Canonical guide: read [`AGENTS.md`](./AGENTS.md)** — it covers the monorepo
> layout, every key subsystem (Game Distribution pipeline & recipes, desktop
> native pipeline runner, admin bulk auto-import, depot chunk cache, plugin SPI,
> launch interceptors, Tauri window model), toolchain, commands, environment
> quirks and conventions. This file only keeps Claude-specific operational notes.

## Quick orientation

- `server/` — Nuxt 3 + Vue 3 (TypeScript, Prisma 7.10, Tailwind, buf/protobuf)
- `backend/` — Go (`go.work`, module `core/`)
- `desktop/src-tauri/` — Rust cargo workspace (Tauri v2 + process/pipeline crates)
- `desktop/main/` — Nuxt `view` UI, **separate pnpm workspace**
- `torrential/` — standalone Rust depot/chunk HTTP server
- `cli/` — Rust `downpour`; `libraries/` — `droplet`, `droplet_types`, `libarchive`, `native_model`, `base/`
- Root pnpm workspace: `server/`, `libraries/base/`, `sites/*`, `desktop/`

## Quality gates — what runs when

| Layer               | When       | What                                                                                  |
| :------------------ | :--------- | :------------------------------------------------------------------------------------ |
| Claude Code hooks   | every edit | format-on-edit (advisory)                                                             |
| lefthook pre-commit | commit     | prettier + eslint --fix on staged files, ast-grep scan, gitleaks                      |
| lefthook pre-push   | push       | server typecheck, clippy (changed crates), golangci-lint, knip report                 |
| GitHub Actions      | PR/push    | typecheck/lint/clippy + gitleaks history scan + cargo-audit ×7 crates + golangci-lint |
| GitHub Actions      | weekly     | semgrep deep scan → Code Scanning                                                     |

Hooks are early feedback; **CI is the authority**. Never disable a hook to make a
failure go away — read the output and fix it. Known red-at-baseline gate:
`torrential` clippy (~227 pre-existing errors, mostly generated `src/proto/version.rs`)
— torrential CI only builds + tests.

### Escape hatches

```sh
git commit --no-verify   # skip pre-commit once
git push --no-verify     # skip pre-push once
LEFTHOOK=0 git commit    # same via env var
```

## Commands

```sh
pnpm exec lefthook run pre-commit --all-files   # dry-run all pre-commit checks
pnpm exec lefthook run pre-push --all-files     # dry-run all pre-push checks
pnpm --filter drop run typecheck                # server
node_modules/.bin/jiti server/server/internal/library/pipeline/__tests__/pipeline.test.ts
pnpm exec ast-grep scan [paths]                 # structural lint (sgconfig.yml)
pnpm exec knip --reporter compact               # unused deps/exports/files report
cd backend && golangci-lint run ./core/...      # Go lint (.golangci.yml in backend/)
gitleaks protect --staged                       # secret scan staged changes
```

Native binaries NOT installable via pnpm:

- `gitleaks` — `brew install gitleaks`
- `cargo-audit` — `cargo install cargo-audit`
- `golangci-lint` — `go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest`
  (must be built with the same Go version as `backend/go.work` or typechecking fails)

## Conventions

- **Commits**: Conventional Commits (`feat(desktop): ...`, `fix(server): ...`),
  one logical change per commit.
- Rust: nightly; prefer explicit errors over `unwrap`/`expect` in new code.
- Formatting: Prettier at the repo root (JS/TS/Vue/YAML/MD); `gofmt`/`goimports` for Go.
- Never commit secrets; never commit `server/prisma/client/`.
