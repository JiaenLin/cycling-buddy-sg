# Update report — raise first-party JavaScript budget to 112 KB

Purpose: Raise `assetBytes.firstPartyJavaScriptMax` from 104000 to 112000 bytes so the cbsg-v26
route-planner redesign can land (a task-oriented sheet with a recommended route + labelled
alternatives, a swap control, an overflow action menu, Recent/Saved shortcuts, map-tap
harmonisation, plus the heading-arrow and exit-clears fixes). This change **only** raises the
ceiling; the code that consumes the headroom ships in the separate cbsg-v26 change, per the
"a budget may not be raised in the same change that exceeds it" rule in
`docs/operations/PERFORMANCE.md`.

Change-risk tier: Tier 2

Tier justification and highest-risk file/behaviour: Governance/config-only change to
`release/performance-budgets.json`. No runtime code, data, service worker, or dependency change. The
only risk is loosening a quality guardrail; mitigated by keeping the increase modest (+7.7 %) and
documenting before/after here.

Production baseline commit / service-worker version: cbsg-v25 (current `origin/main`).

Files changed:
- `release/performance-budgets.json` — `firstPartyJavaScriptMax` 104000 → 112000.
- `release/reports/first-party-js-budget-112kb.md` — this report.

User-visible changes: None (budget/config only).

Behaviours intentionally unchanged: All runtime behaviour, rendered output, data, caching and
privacy posture.

Data / schema / cache / privacy impact: None.

Required gates for this tier: deterministic verification (syntax, JSON, data, security, governance,
performance). No browser tier is required for a config-only change; the full CI matrix still runs.

Automated checks and exact results: `npm run verify:deterministic` — PASS. Performance budget PASS at
this commit: firstPartyJavaScript 101535 / 112000 bytes (the tree here is unchanged v25 code, so it
sits well under both the old and new ceilings — this change does not itself exceed any budget).

Manual environments and exact results: N/A (no runtime change).

Generated asset count / size changes: None.

Before/after measurements (reference profile: Pixel 7-class / Fast 4G, per
`performance-budgets.json` `referenceProfile`):
- Budget `firstPartyJavaScriptMax`: 104000 → 112000 bytes (+8000, +7.7 %).
- Actual first-party JS (`app.js` + `router.js` + `sw.js`):
  - cbsg-v25 (current main): 101535 bytes.
  - cbsg-v26 (projected, with the planner redesign + fixes): ~108929 bytes.
- The new ceiling leaves ~3.1 KB headroom. First-party JS remains a small fraction of the runtime
  (877 KB vendored MapLibre, 7.6 MB routing graph, 175 KB postcode index); the increment is cached,
  already-parsed, and has negligible effect on the appReady / FCP / LCP timing budgets, which are
  unchanged.

User impact: None negative. Enables the cbsg-v26 planner. The added ~7.4 KB of cached first-party JS
is immaterial under the reference profile.

New service-worker version: Unchanged by this change (remains cbsg-v25 on main; cbsg-v26 ships in the
feature change).

Deployment HTTP verification: N/A for this config change; the cbsg-v26 feature change carries preview
verification.

Known limitations or unverified areas: None.

Rollback commit, forward version, and procedure: Revert this commit to restore
`firstPartyJavaScriptMax` to 104000. No runtime effect — the gate simply tightens again. Forward-only
recovery per `docs/operations/INCIDENT_RESPONSE.md` if ever needed.
