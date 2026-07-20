# Update report — raise first-party JavaScript budget to 104 KB

Purpose: Raise `assetBytes.firstPartyJavaScriptMax` from 100000 to 104000 bytes so the cbsg-v25
feature set (heading arrowhead on the location dot, redesigned route planner, phone-layout
stability fixes, and offline postcode search) can land. This change **only** raises the ceiling; the
code that consumes the headroom ships in the separate cbsg-v25 change, per the "a budget may not be
raised in the same change that exceeds it" rule in `docs/operations/PERFORMANCE.md`.

Change-risk tier: Tier 2

Tier justification and highest-risk file/behaviour: Governance/config-only change to
`release/performance-budgets.json`. No runtime code, data, service worker, or dependency change. The
only risk is loosening a quality guardrail; mitigated by keeping the increase small (+4.0 %) and
documenting before/after here.

Production baseline commit / service-worker version: cbsg-v24 (current `origin/main`).

Files changed:
- `release/performance-budgets.json` — `firstPartyJavaScriptMax` 100000 → 104000.
- `release/reports/first-party-js-budget-104kb.md` — this report.

User-visible changes: None (budget/config only).

Behaviours intentionally unchanged: All runtime behaviour, rendered output, data, caching and
privacy posture.

Data / schema / cache / privacy impact: None.

Required gates for this tier: deterministic verification (syntax, JSON, data, security, governance,
performance). No browser tier is required for a config-only change; the full CI matrix still runs.

Automated checks and exact results: `npm run verify:deterministic` — PASS. Performance budget PASS at
this commit: firstPartyJavaScript 98621 / 104000 bytes (the tree here is unchanged v24 code, so it
sits well under both the old and new ceilings — this change does not itself exceed any budget).

Manual environments and exact results: N/A (no runtime change).

Generated asset count / size changes: None.

Before/after measurements (reference profile: Pixel 7-class / Fast 4G, per
`performance-budgets.json` `referenceProfile`):
- Budget `firstPartyJavaScriptMax`: 100000 → 104000 bytes (+4000, +4.0 %).
- Actual first-party JS (`app.js` + `router.js` + `sw.js`):
  - cbsg-v24 (current main): 98621 bytes.
  - cbsg-v25 (projected, with all four features): ~100360 bytes.
- The new ceiling leaves ~3.6 KB headroom. First-party JS remains a small fraction of the runtime
  (877 KB vendored MapLibre, 7.6 MB routing graph); the increment is cached, already-parsed, and has
  negligible effect on the appReady / FCP / LCP timing budgets, which are unchanged.

User impact: None negative. Enables the requested cbsg-v25 features. The added ~1.7 KB of cached
first-party JS is immaterial under the reference profile.

New service-worker version: Unchanged by this change (remains cbsg-v24 on main; cbsg-v25 ships in the
feature change).

Deployment HTTP verification: N/A for this config change; the cbsg-v25 feature change carries preview
verification.

Known limitations or unverified areas: None.

Rollback commit, forward version, and procedure: Revert this commit to restore
`firstPartyJavaScriptMax` to 100000. No runtime effect — the gate simply tightens again. Forward-only
recovery per `docs/operations/INCIDENT_RESPONSE.md` if ever needed.
