# Update report — raise first-party JavaScript budget to 150 KB

Purpose: Raise `assetBytes.firstPartyJavaScriptMax` from 124000 to 150000 bytes. cbsg-v37 (weather-row
redesign + three new NEA real-time readings + five UX fixes) lands at 123,964 B — under the old
ceiling — but the ceiling has been reached three releases running (v25 104 KB, v26 112 KB, v27 118 KB,
v34 124 KB), so each feature triggers another owner-approved raise PR. The owner approved a larger,
one-time headroom bump to **150 KB** to stop the repeated interruptions.

Because cbsg-v37 does **not** exceed the current 124 KB budget, the "a budget may not be raised in the
same change that exceeds it" rule (`docs/operations/PERFORMANCE.md`) does not apply, so this raise ships
in the cbsg-v37 change rather than a separate budget-only PR.

Change-risk tier: Tier 2

Tier justification and highest-risk file/behaviour: Config change to `release/performance-budgets.json`
(loosening a quality guardrail), shipped alongside the cbsg-v37 runtime change. The budget increase
itself carries no runtime behaviour; the only risk is a looser ceiling, mitigated by the report and by
first-party JS remaining a small fraction of the runtime.

Production baseline commit / service-worker version: cbsg-v36 (current `origin/main`).

Files changed (budget):
- `release/performance-budgets.json` — `firstPartyJavaScriptMax` 124000 → 150000.
- `release/reports/first-party-js-budget-150kb.md` — this report.

User-visible changes: None from the budget change (the cbsg-v37 feature changes are separate).

Behaviours intentionally unchanged: All runtime behaviour except the cbsg-v37 features.

Data / schema / cache / privacy impact: None.

Required gates for this tier: deterministic verification (syntax, JSON, data, security, governance,
performance), plus the full browser / accessibility / performance / recovery matrix for the cbsg-v37
runtime changes shipped with it.

Automated checks and exact results: `npm run verify:deterministic` — PASS; performance budget PASS at
firstPartyJavaScript 123,964 / 150,000 bytes. Full Playwright matrix — 144 passed.

Before/after measurements (reference profile: Pixel 7-class / Fast 4G):
- Budget `firstPartyJavaScriptMax`: 124000 → 150000 bytes (+26000, +21 %).
- Actual first-party JS (`app.js` + `router.js` + `sw.js`): cbsg-v36 122,860 → cbsg-v37 123,964 bytes.
- New ceiling leaves ~26 KB headroom. First-party JS remains a small fraction of the runtime
  (877 KB vendored MapLibre, 7.6 MB routing graph); the increment is cached, already-parsed, and has
  negligible effect on the appReady / FCP / LCP timing budgets (unchanged).

User impact: None negative. Removes the recurring per-release budget-raise friction.

New service-worker version: cbsg-v37 (shipped in the same change).

Deployment HTTP verification: Carried by the cbsg-v37 preview verification.

Known limitations or unverified areas: None.

Rollback: Revert this commit to restore `firstPartyJavaScriptMax` to 124000. No runtime effect — the
gate simply tightens again.
