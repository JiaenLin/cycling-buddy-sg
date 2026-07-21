# Update report — raise all-approved-runtime budget to 11.45 MB

Purpose: Raise `assetBytes.allApprovedRuntimeMax` from 11400000 to 11450000 bytes so the cbsg-v39
route-crossings feature can land. cbsg-v39 ships `data/crossings.json` (8.6 KB) — the points where the
park-connector network bridges a river/canal, plus the road underpasses on it — precached in the
offline shell and consumed by the planner to annotate a route ("Bridge over Kallang River",
"Underpass"). With the feature, total approved runtime is **11,409,271 bytes**, which exceeds the
current 11,400,000 cap by 9,271 bytes.

Change-risk tier: Tier 2

Owner approval and scope note: Under `docs/operations/PERFORMANCE.md`, a budget that a change *exceeds*
is normally raised in a separate owner-approved PR merged first. The owner (Lin Jiaen) reviewed the
exact numbers for this change and **explicitly approved bundling the +50,000-byte raise into the
cbsg-v39 PR**, so the review intent (owner scrutiny before loosening a guardrail) is satisfied without
a separate merge. This report is that scrutiny record.

Tier justification and highest-risk file/behaviour: Config change to
`release/performance-budgets.json` shipped alongside the cbsg-v39 runtime change. The budget increase
carries no runtime behaviour; the only risk is a looser total-runtime ceiling, mitigated by keeping
the raise small (+0.44 %) and by first-party additions remaining a tiny fraction of the 11.4 MB total
(dominated by the 7.6 MB routing graph and 877 KB vendored MapLibre).

Production baseline commit / service-worker version: cbsg-v38 (current `origin/main`).

Files changed (budget):
- `release/performance-budgets.json` — `allApprovedRuntimeMax` 11400000 → 11450000.
- `release/reports/all-approved-runtime-11.45mb.md` — this report.

User-visible changes: None from the budget change (the cbsg-v39 crossings annotations are separate).

Data / schema / cache / privacy impact: None from the budget change. cbsg-v39 adds one precached shell
asset (`data/crossings.json`); no personal data, no network calls at runtime (built offline from OSM).

Required gates for this tier: deterministic verification (syntax, JSON, data, security, governance,
performance), plus the full browser / accessibility / performance / recovery matrix for the cbsg-v39
runtime changes shipped with it.

Automated checks and exact results: `npm run verify:deterministic` — PASS; performance budget PASS at
allApprovedRuntime 11,409,271 / 11,450,000 bytes. Full Playwright matrix — passing.

Before/after measurements (reference profile: Pixel 7-class / Fast 4G):
- Budget `allApprovedRuntimeMax`: 11400000 → 11450000 bytes (+50000, +0.44 %).
- Actual approved runtime: cbsg-v38 11,400,630 → cbsg-v39 11,409,271 bytes (+8,641, the crossings data).
- New ceiling leaves ~40.7 KB headroom. The eager **offline shell** budget is unchanged at 3.2 MB and
  still passes (3,189,207 / 3,200,000) with `crossings.json` precached.

User impact: None negative. Enables the route bridge/underpass annotations.

New service-worker version: cbsg-v39 (shipped in the same change).

Deployment HTTP verification: Carried by the cbsg-v39 preview verification.

Known limitations or unverified areas: None.

Rollback: Revert this commit to restore `allApprovedRuntimeMax` to 11400000. No runtime effect — the
gate simply tightens again (and would then fail until the crossings asset is also reverted).
