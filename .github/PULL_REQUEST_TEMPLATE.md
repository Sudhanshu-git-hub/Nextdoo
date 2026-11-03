# Pull request: <title>

## Summary

<!-- Describe what this change does and why it is needed. Link the issue it addresses. -->

Related issue: <issue number or "none">

## Changes made

<!-- Summarize the concrete changes. Reference files/areas touched. -->

## Tests performed

<!-- Report exact results from actual command output. Do not claim tests passed without running them. -->

| Command | Result |
|---|---|
| `pnpm lint` | <!-- pass/fail + summary --> |
| `pnpm typecheck` | <!-- pass/fail + summary --> |
| `pnpm test` (or `pnpm test:unit`) | <!-- e.g. 1134 passed / 0 failed --> |
| `pnpm test:coverage` | <!-- coverage summary if run --> |
| `pnpm build` | <!-- pass/fail --> |
| `pnpm test:e2e` | <!-- pass/fail + scenario count if run --> |
| `pnpm security:scan` | <!-- 0 prohibited findings / details --> |

## Screenshots for UI changes

<!-- Before/after screenshots if the PR changes visible UI. Remove any personal data. -->

## Database migration impact

<!-- None, or describe the new forward migration(s), their additivity, and how you verified fresh-install and upgrade paths. Remember: never edit applied migrations. -->

- [ ] No migration needed
- [ ] New migration(s) added (list files): <!-- e.g. 0032_xxx.sql -->

## Security implications

<!-- Does this change authentication, authorization, data isolation, file handling, secrets, or logs? If yes, describe the review performed. -->

- [ ] No security-sensitive surfaces touched
- [ ] Security-sensitive surfaces touched (describe below)

## Checklist

- [ ] Branch follows the naming convention (`feat/`, `fix/`, `docs/`, `security/`, …)
- [ ] Commits use Conventional Commits format
- [ ] All gates above pass on this branch
- [ ] Documentation updated where behavior changed
- [ ] No credentials, tokens, or private data included
