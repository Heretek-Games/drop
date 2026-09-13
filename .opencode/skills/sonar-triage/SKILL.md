---
name: sonar-triage
description: Use when triaging SonarCloud findings for this repository (quality gate red, new issues, "fix sonar", "sonar list issues", "quality gate", or when a push triggers SonarCloud analysis). Covers authenticating the sonar CLI, listing issues, and the fix/NOSONAR/accept decision policy.
---

# SonarCloud triage for Heretek-Games/drop

## Project facts

- Project key: `Heretek-Games_drop` (org `heretek-games`), default branch `develop`.
- Analysis is **automatic** on push; the remote analysis is authoritative.
- The quality gate enforces the **last 30 days** of new code (new-code ratings A, new duplicated lines density < 3 %, hotspots reviewed 100 %).
- Project exclusions: `server/prisma/migrations/**` (generated/historical SQL) and vendored `libraries/{libarchive,native_model}/**/Cargo.toml`.
- Local rule parity lives in `eslint.config.shared.mjs` (sonarjs, regexp, unicorn, vuejs-a11y) plus ruff (Python) and shellcheck/hadolint/actionlint hooks.
- The root `knip` check is report-only; migrations and vendored crates are excluded.

## Authenticate the CLI

Ensure the `sonar` CLI is on your `PATH` (Homebrew, `mise`, or your package
manager), then source your token and confirm it works:

```sh
. "$HOME/.config/sonar/env" # personal token; often sourced by ~/.bashrc
sonar auth status
```

## Triage loop

1. Fetch open issues, grouped by rule:

   ```sh
   sonar list issues -p Heretek-Games_drop --format json > /tmp/sonar.json
   python3 -c "import json,collections;d=json.load(open('/tmp/sonar.json'));print(collections.Counter(i['rule'] for i in d['issues']))"
   ```

2. `sonar quality-gate status -p Heretek-Games_drop` for the gate verdict.
3. For each rule, decide:
   - **Fix** when the issue is real (behaviour, safety, accessibility, complexity above 15).
   - **NOSONAR** when the analyzer cannot see a sanitizer, only as a trailing comment on the exact flagged line, with a short justification.
   - **Accept** when it is intentional (e.g. tracked TODO markers) via `sonar api post /api/issues/do_transition` with `{"issue":"<key>","transition":"accept","comment":"reason"}`.
4. Verify locally before pushing:
   - `pnpm run lint` (all workspaces)
   - `pnpm -C server run typecheck && pnpm -C server run test`
   - `pnpm -C desktop/main run typecheck`
5. Push; the next automatic analysis should show the issues resolved. Never mark a fix as done without the analysis or a local command confirming it.

## Policy notes

- Do not edit `server/prisma/migrations/**` to silence SQL findings; scope excludes it instead.
- Prefer fixing the root cause over suppressions; every NOSONAR needs a one-line reason.
- Accepted findings must carry a rationale comment in SonarCloud.
