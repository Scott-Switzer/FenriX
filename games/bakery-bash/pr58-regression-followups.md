# PR #58 Regression Follow-ups

> **Context:** PR #58 merged on a stale `main` and its conflict resolution silently reverted parts of PR #57. PR #62 (`fix/csv-inbox-types`) restored the type exports + `GameState.acquiredCsvs` to get `tsc -b` and `eslint` clean again — but the **runtime features** those types supported are still missing. This file tracks the feature-level regressions that need to be restored, each as its own auditable PR.

**Baseline:** Compare `c348aed` (PR #57 merged) vs current `main` for any item below.
**Opened by:** PR #62 comment at <https://github.com/fenrix-ai/FenriX/pull/62#issuecomment-4302991939>
**Last updated:** 2026-04-23 (post-#66)

---

## How to read

- Each item is an **independent PR**. Do not bundle.
- **Status** values: `todo`, `in-progress (branch)`, `in-review (PR#)`, `shipped (PR#)`.
- Before starting any item, `git diff c348aed main -- <path>` to see exactly what PR #58's merge dropped.

---

## 1. `ADD_ACQUIRED_CSV` reducer case — CSV Inbox population

**Status:** shipped (PR #63)
**Files:** `games/bakery-bash/app/src/contexts/GameContext.tsx`
**What broke:** The reducer case that pushes a new `AcquiredCsv` into `state.acquiredCsvs` was deleted. Without it, `acquiredCsvs` stays `[]` forever and the inbox renders permanently empty.
**Acceptance:** Dispatching `{ type: 'ADD_ACQUIRED_CSV', payload: <AcquiredCsv> }` appends the entry; duplicate `id`s are not added twice.
**Bundled with:** items 2 + 3 (CSV Inbox feature end-to-end).

## 2. `CsvInboxModal` mount in `RoundHeader`

**Status:** shipped (PR #63)
**Files:** `games/bakery-bash/app/src/components/game/RoundHeader.tsx`
**What broke:** The header's mail-icon button no longer opens the inbox modal — it still triggers the legacy direct-download behaviour. The `<CsvInboxModal>` component file compiles but is imported by nothing at HEAD, so the feature is unreachable.
**Acceptance:** Clicking the mail button opens the inbox modal; it lists every `AcquiredCsv` currently in `GameState.acquiredCsvs`; closing works; re-clicking the Download link on a row re-downloads without re-charging.
**Bundled with:** items 1 + 3.

## 3. Purchasable-data buttons in `GameSidebar`

**Status:** shipped (PR #63)
**Files:** `games/bakery-bash/app/src/components/game/GameSidebar.tsx`
**What broke:** The Finance-gated buttons to purchase competitor intel + Tier 1 / Tier 2 chef CSVs were removed. Even with items 1 + 2 restored, users have no way to populate `acquiredCsvs`.
**Acceptance:** Finance role sees three purchase buttons with visible costs; clicking charges the team budget, dispatches `ADD_ACQUIRED_CSV`, and the newly acquired CSV appears in the inbox within the same render pass.
**Bundled with:** items 1 + 2.

## 4. `RoundEvent` / `RoundEventKind` types + events system

**Status:** in-progress (`fix/restore-round-events-system`)
**Files:** `games/bakery-bash/app/src/types/game.ts`, `games/bakery-bash/app/src/pages/phases/ResultsPhase.tsx`, `games/bakery-bash/app/src/pages/phases/SimulatePhase.tsx`, `games/bakery-bash/app/src/styles/global.css` (`.event-card*` rules).
**What broke:** The `RoundEvent` type + the `events?: RoundEvent[]` field on `RoundResult` were dropped; the `EventCard` renderer + "Events" section + legacy-burglary synthesizer were dropped from `ResultsPhase`; all `.event-card*` CSS was dropped. `ResultsPhase` + `SimulatePhase` currently fall through to an inline `latest?.burglary && <div>` banner with an `any`-cast to read `burglaryAmount` — PR #62's transitional shim. Backend continues to emit the flat `burglary` / `burglaryAmount` fields at both baseline `c348aed` and current `main` (checked `backend/functions/modules/simulation.js`), so the synthesizer is the correct permanent pattern — no backend change required.
**Acceptance:** Server-emitted round events (via legacy flat fields OR explicit `events[]`) are consumed and rendered as `EventCard`s on the Results screen.
**Scope clarification:** The doc originally listed `AdWin` as a missing type. On audit, no top-level `AdWin` type ever existed — `AdWinnerBanner.tsx` has a local `AdWinnerEntry` interface that is identical between `c348aed` and `main` (`git diff c348aed main -- .../AdWinnerBanner.tsx` returns empty). So there is nothing to restore on the ad-winners side; item 4 is just the round-events system.

## 5. `ChefListing.minBidFloor`

**Status:** shipped (PR #66)
**Files:** `games/bakery-bash/app/src/types/game.ts` (add field), `games/bakery-bash/app/src/pages/AuctionPage.tsx` (render + client-side floor check), possibly `games/bakery-bash/backend/functions/modules/chef-system.js` if server needs to echo the value.
**What broke:** Per-chef minimum bid floor is no longer rendered or enforced on the client. Backend still rejects under-floor bids (via `MIN_BID_FLOOR_MULTIPLIERS` in `chef-system.js`), so the UX is: user submits a too-low bid and sees a bare error message instead of proactive UI guardrails.
**Acceptance:** `ChefCard` shows the minimum bid; bid input disables / shows inline validation below the floor; server still double-checks.
**Tracked in parallel:** Apr 22 `playtesting-apr22-remaining-tasks.md` BE-R05 (server-side) — coordinate.

## 6. `PLAYER_ROLE_LABELS`-delegating owner-copy helpers

**Status:** shipped (PR #70)
**Files:** `games/bakery-bash/app/src/types/game.ts`.
**What broke:** The 4 `ownerOf*` helpers exist but return hardcoded strings instead of delegating to `PLAYER_ROLE_LABELS`. Most visibly, `ownerOfAdBids()` returns `"Advertising"` while `PLAYER_ROLE_LABELS.advertising` is `"Bidder"` — so the auction page tooltip says "Your Advertising teammate submits this decision" while the lobby role-picker and How-to-Play page call that same role "Bidder".
**Acceptance:** All owner-copy strings (e.g., "Your Bidder is…", "Finance owns pricing", etc.) derive from one source of truth.

## 7. `GameProgressBar` component + mount in `RoundHeader`

**Status:** shipped (PR #69)
**Files:** `games/bakery-bash/app/src/components/game/RoundHeader.tsx` (remount), `games/bakery-bash/app/src/styles/global.css` (`.round-header__progress` + `.game-progress*` rules).
**What broke:** PR #62 restored the `GameProgressBar.tsx` component file but not the mount or its CSS. With no mount the round-progress visualization strip inside `RoundHeader` is absent; with no CSS it'd render unstyled.
**Acceptance:** Progress bar renders below the phase banner; `currentRound / totalRounds` filled portion is visible; matches `c348aed` design.

## 8. ~3500-line UX polish sweep from PR #57

**Status:** todo (probably needs to be broken into sub-items)
**Scope (non-exhaustive):**
- Landing modals (create-team / join-team refinements that PR #58 flattened)
- Simulation bakery-interior art + animation pass
- Conclusion podium screen
- Event cards on ResultsPhase (tied to item 4)
- Misc copy + tab/badge styling
**Approach:** Skim `git diff c348aed main -- games/bakery-bash/app/src/` section by section, extract cohesive sub-features, file each as a PR. Do **not** attempt to re-land PR #57 wholesale — conflicts with subsequent PRs #60 / #61 will be massive.

---

## Ground rules

1. **One item per PR** unless explicitly bundled above (items 1–3 are one feature).
2. **Baseline diff** (`git diff c348aed main -- <path>`) before touching any file — so reviewers can audit "this is a restoration, not new design".
3. **tsc + eslint clean** before pushing. PR #62 set the baseline at zero errors.
4. **Runtime verify** in the emulator for anything user-visible (items 1–3, 5, 7, 8). Tsc-only restorations can skip, but call it out in the PR body.
