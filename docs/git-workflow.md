# Git Workflow

## Branches

- `main` — Always deployable. Protected. All changes go through PRs.
- `feature/short-description` — New features (e.g., `feature/leaderboard-ui`)
- `fix/short-description` — Bug fixes (e.g., `fix/auction-timer-sync`)

## Commit Messages

Use present tense, imperative mood:
- "add leaderboard component" (not "added leaderboard component")
- "fix auction bid validation" (not "fixed auction bid validation")
- "update firebase rules for auth" (not "updated firebase rules for auth")

## Pull Requests

1. All merges to `main` require a PR.
2. Use the PR template (auto-loaded from `.github/PULL_REQUEST_TEMPLATE.md`).
3. At least one approval required before merging.
4. Squash merge preferred to keep history clean.

## Quick Reference

```bash
# Start a new feature
git checkout main
git pull origin main
git checkout -b feature/my-feature

# Work, commit, push
git add .
git commit -m "add my feature"
git push origin feature/my-feature

# Open a PR on GitHub, get it reviewed, merge
```
