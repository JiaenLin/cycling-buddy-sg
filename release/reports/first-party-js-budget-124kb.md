# Update report — raise first-party JavaScript budget to 124 KB

Purpose: Raise `assetBytes.firstPartyJavaScriptMax` from 118000 to 124000 bytes so the cbsg-v34 UI
refresh can land — a calmer default screen where the map leads: a draggable dock (pull the handle to
expand/collapse), a merged weather + go/no-go row, a "Plan a ride" dock CTA with a quiet "Record a
ride" link, the route line-icon removed from the FAB stack, a clearer location-pin Locate icon, the
weather (rain-zone) button relocated from the top bar into the FAB stack, Theme moved first, and
Compass + Record revealed in the FAB stack only during a ride (GO). This change **only** raises the
ceiling; the code that consumes the headroom ships in the separate cbsg-v34 change, per the
"a budget may not be raised in the same change that exceeds it" rule in
`docs/operations/PERFORMANCE.md`.

Change-risk tier: Tier 2

Tier justification and highest-risk file/behaviour: Governance/config-only change to
`release/performance-budgets.json`. No runtime code, data, service worker, or dependency change. The
only risk is loosening a quality guardrail; mitigated by keeping the increase modest (+5.1 %) and
documenting before/after here.

Production baseline commit / service-worker version: cbsg-v33 (current `origin/main`).

Files changed:
- `release/performance-budgets.json` — `firstPartyJavaScriptMax` 118000 → 124000.
- `release/reports/first-party-js-budget-124kb.md` — this report.

User-visible changes: None (budget/config only).

Behaviours intentionally unchanged: All runtime behaviour, rendered output, data, caching and
privacy posture.

Data / schema / cache / privacy impact: None.

Required gates for this tier: deterministic verification (syntax, JSON, data, security, governance,
performance). No browser tier is required for a config-only change; the full CI matrix still runs.

Automated checks and exact results: `npm run verify:deterministic` — PASS. Performance budget PASS at
this commit: the tree here is unchanged cbsg-v33 code (first-party JS 117394 / 124000 bytes), so it
sits well under both the old and new ceilings — this change does not itself exceed any budget.

Manual environments and exact results: N/A (no runtime change).

Generated asset count / size changes: None.

Before/after measurements (reference profile: Pixel 7-class / Fast 4G, per
`performance-budgets.json` `referenceProfile`):
- Budget `firstPartyJavaScriptMax`: 118000 → 124000 bytes (+6000, +5.1 %).
- Actual first-party JS (`app.js` + `router.js` + `sw.js`):
  - cbsg-v33 (current main): 117394 bytes.
  - cbsg-v34 (measured, with the UI refresh): 118950 bytes.
- The new ceiling leaves ~5.1 KB headroom. First-party JS remains a small fraction of the runtime
  (877 KB vendored MapLibre, 7.6 MB routing graph, 175 KB postcode index, 7 KB MRT index); the
  increment is cached, already-parsed, and has negligible effect on the appReady / FCP / LCP timing
  budgets, which are unchanged (measured LCP 1800 ms, CLS 0.034 on the reference profile).

User impact: None negative. Enables the cbsg-v34 UI refresh. The added ~1.6 KB of cached first-party
JS is immaterial under the reference profile.

New service-worker version: Unchanged by this change (remains cbsg-v33 on main; cbsg-v34 ships in the
feature change).

Deployment HTTP verification: N/A for this config change; the cbsg-v34 feature change carries preview
verification.

Known limitations or unverified areas: None.

Rollback commit, forward version, and procedure: Revert this commit to restore
`firstPartyJavaScriptMax` to 118000. No runtime effect — the gate simply tightens again. Forward-only
recovery per `docs/operations/INCIDENT_RESPONSE.md` if ever needed.
