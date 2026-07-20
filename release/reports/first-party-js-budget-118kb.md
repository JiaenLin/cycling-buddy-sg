# Update report — raise first-party JavaScript budget to 118 KB

Purpose: Raise `assetBytes.firstPartyJavaScriptMax` from 112000 to 118000 bytes so the cbsg-v27
planner work can land (a harmonised From/To with search + map-tap + a ⌖ current-location option and
start→destination glow guidance, offline MRT/LRT station search, plus fixes for the heading arrow,
the collapsible alternatives, the GO button and Save destination). This change **only** raises the
ceiling; the code that consumes the headroom ships in the separate cbsg-v27 change, per the
"a budget may not be raised in the same change that exceeds it" rule in
`docs/operations/PERFORMANCE.md`.

Change-risk tier: Tier 2

Tier justification and highest-risk file/behaviour: Governance/config-only change to
`release/performance-budgets.json`. No runtime code, data, service worker, or dependency change. The
only risk is loosening a quality guardrail; mitigated by keeping the increase modest (+5.4 %) and
documenting before/after here.

Production baseline commit / service-worker version: cbsg-v26 (current `origin/main`).

Files changed:
- `release/performance-budgets.json` — `firstPartyJavaScriptMax` 112000 → 118000.
- `release/reports/first-party-js-budget-118kb.md` — this report.

User-visible changes: None (budget/config only).

Behaviours intentionally unchanged: All runtime behaviour, rendered output, data, caching and
privacy posture.

Data / schema / cache / privacy impact: None.

Required gates for this tier: deterministic verification (syntax, JSON, data, security, governance,
performance). No browser tier is required for a config-only change; the full CI matrix still runs.

Automated checks and exact results: `npm run verify:deterministic` — PASS. Performance budget PASS at
this commit: firstPartyJavaScript 110050 / 118000 bytes (the tree here is unchanged v26 code, so it
sits well under both the old and new ceilings — this change does not itself exceed any budget).

Manual environments and exact results: N/A (no runtime change).

Generated asset count / size changes: None.

Before/after measurements (reference profile: Pixel 7-class / Fast 4G, per
`performance-budgets.json` `referenceProfile`):
- Budget `firstPartyJavaScriptMax`: 112000 → 118000 bytes (+6000, +5.4 %).
- Actual first-party JS (`app.js` + `router.js` + `sw.js`):
  - cbsg-v26 (current main): 110050 bytes.
  - cbsg-v27 (measured, with the planner harmonisation + MRT search + fixes): 114028 bytes.
- The new ceiling leaves ~3.9 KB headroom. First-party JS remains a small fraction of the runtime
  (877 KB vendored MapLibre, 7.6 MB routing graph, 175 KB postcode index, 7 KB MRT index); the
  increment is cached, already-parsed, and has negligible effect on the appReady / FCP / LCP timing
  budgets, which are unchanged (measured LCP 1584 ms, CLS 0.033 on the reference profile).

User impact: None negative. Enables the cbsg-v27 planner and MRT search. The added ~5 KB of cached
first-party JS is immaterial under the reference profile.

New service-worker version: Unchanged by this change (remains cbsg-v26 on main; cbsg-v27 ships in the
feature change).

Deployment HTTP verification: N/A for this config change; the cbsg-v27 feature change carries preview
verification.

Known limitations or unverified areas: None.

Rollback commit, forward version, and procedure: Revert this commit to restore
`firstPartyJavaScriptMax` to 112000. No runtime effect — the gate simply tightens again. Forward-only
recovery per `docs/operations/INCIDENT_RESPONSE.md` if ever needed.
