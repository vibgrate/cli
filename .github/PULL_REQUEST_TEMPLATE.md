# Pull Request

## Summary

<!-- What does this change do and why? -->

## Related issues

<!-- e.g. Closes #123 -->

## Checklist

- [ ] `pnpm test` passes
- [ ] `pnpm lint` is clean
- [ ] `pnpm typecheck` is clean
- [ ] Docs updated (README / DOCS / ARCHITECTURE) where behavior changed
- [ ] **Determinism preserved** — identical input still produces identical
      `graph.json` / report output (content-hashed IDs, stable sorts; no time,
      randomness, or filesystem-order dependence)
- [ ] No proprietary or internal references — public, Apache-2.0 content only
- [ ] Commits use Conventional Commits and are signed off (`git commit -s`, DCO)

## Notes for reviewers

<!-- Anything that needs special attention, trade-offs, follow-ups. -->
