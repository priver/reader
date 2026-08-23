# Reader

Reader is a chronological RSS and Atom web reader with no ranking algorithm. The repository contains
only the end-user React scaffold. Documents under `docs/` define the target through invitation beta
unless they say otherwise.

<!-- intent-skills:start -->

## Skill loading

Before editing files for a substantial task:

- Run `pnpm dlx @tanstack/intent@latest list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `pnpm dlx @tanstack/intent@latest load <package>#<skill>`
  before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer
  the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are
  changing; load additional skills only when the task spans multiple packages or concerns.

<!-- intent-skills:end -->

## Current commands

- Run the end-user app with `pnpm --filter @priver/reader-web dev`.
- Build current packages with `pnpm build`.
- Run current checks with `pnpm check`.

Use package scripts now. Once the repository has a `justfile`, use `just --list` to find
cross-language tasks.

## Hard rules

- Verify current code and configuration before treating target documentation as implemented.
- Regenerate files with their generator. This applies to TanStack route trees and, once present,
  OpenAPI and sqlc output.
- Apply database changes through migrations. Sequence production migrations with expand-contract so
  blue and green versions can overlap safely.
- Update every affected design document in the same change as the behavior it describes.

## Documentation map

Use every row whose trigger matches the planned edits.

| Trigger                                           | Read                                            |
| ------------------------------------------------- | ----------------------------------------------- |
| Product behavior, scope, UX, rollout              | `docs/product.md`                               |
| Service boundary, repository layout, request flow | `docs/architecture.md`                          |
| Schema, ownership, state, retention, deletion     | `docs/data-model.md`, ADR 0003                  |
| Feed discovery, parsing, or rendered body         | `docs/product.md`, `docs/security.md`, ADR 0001 |
| Identity, sessions, invitations, admin access     | `docs/security.md`, ADR 0002                    |
| Image normalization, proxy, variants, cache       | `docs/security.md`, ADR 0004                    |
| Tests, fixtures, accessibility, performance gates | `docs/testing.md`                               |
| Cloud, secrets, migrations, release, recovery     | `docs/deployment.md`, ADR 0005                  |
| Deliberate tradeoff not covered above             | `docs/decisions/`                               |

## Completion

Before declaring work complete:

1. Run the relevant checks from the affected packages or root task runner.
2. Regenerate affected artifacts and confirm they match their source definitions.
3. Confirm behavior, target-state docs, and ADRs still agree.
4. Report each check that could not run and the remaining risk.
