# Update report — raise all-approved-runtime budget to 11.4 MB

Purpose: Raise `assetBytes.allApprovedRuntimeMax` from 11200000 to 11400000 bytes so the cbsg-v29
rideable-network layer can land. cbsg-v29 ships `data/rideable.lines.geojson` (196 KB) — the OSM
cycling paths the router can use that the LTA/NParks display layers don't draw — as a
**supplementalRuntimeAsset** so the map matches what the router can ride. This change **only** raises
the ceiling; the code and data that consume the headroom ship in the separate cbsg-v29 change, per
the "a budget may not be raised in the same change that exceeds it" rule in
`docs/operations/PERFORMANCE.md`.

Change-risk tier: Tier 2

Tier justification and highest-risk file/behaviour: Governance/config-only change to
`release/performance-budgets.json`. No runtime code, data, service worker, or dependency change. The
only risk is loosening a quality guardrail; mitigated by keeping the increase modest (+1.8 %) and
documenting before/after here. The raised budget is `allApprovedRuntime` (eager shell + supplemental
runtime assets); the **eager offline shell budget is unchanged** — the new asset is runtime-cached
on first fetch, not precached, so a first offline launch is unaffected.

Production baseline commit / service-worker version: cbsg-v28 (current `origin/main`).

Files changed:
- `release/performance-budgets.json` — `allApprovedRuntimeMax` 11200000 → 11400000.
- `release/reports/all-approved-runtime-11.4mb.md` — this report.

User-visible changes: None (budget/config only).

Behaviours intentionally unchanged: All runtime behaviour, rendered output, data, caching and
privacy posture. `offlineShellMax` is unchanged.

Data / schema / cache / privacy impact: None.

Required gates for this tier: deterministic verification (syntax, JSON, data, security, governance,
performance). No browser tier is required for a config-only change; the full CI matrix still runs.

Automated checks and exact results: `npm run verify:deterministic` — PASS. Performance budget PASS at
this commit: allApprovedRuntime 11057095 / 11400000 bytes (the tree here is unchanged v28 code, so it
sits well under both the old and new ceilings — this change does not itself exceed any budget).

Manual environments and exact results: N/A (no runtime change).

Generated asset count / size changes: None.

Before/after measurements (reference profile: Pixel 7-class / Fast 4G, per
`performance-budgets.json` `referenceProfile`):
- Budget `allApprovedRuntimeMax`: 11200000 → 11400000 bytes (+200000, +1.8 %).
- Actual all-approved-runtime (eager shell + supplemental assets):
  - cbsg-v28 (current main): 11057095 bytes.
  - cbsg-v29 (measured, with the 196 KB rideable layer): 11254174 bytes.
- The new ceiling leaves ~146 KB headroom. `offlineShell` is unchanged at ~3.14 MB (rideable is a
  supplemental, not shell, asset); `firstPartyJavaScript` is unaffected (116 KB / 118 KB). The added
  196 KB is a cached vector layer with negligible effect on the appReady / FCP / LCP timing budgets
  (measured LCP 1580 ms, CLS 0.033 on the reference profile with the layer present).

User impact: None negative. Enables the cbsg-v29 rideable-network layer so the displayed cycling
paths match what the router can actually ride.

New service-worker version: Unchanged by this change (remains cbsg-v28 on main; cbsg-v29 ships in the
feature change).

Deployment HTTP verification: N/A for this config change; the cbsg-v29 feature change carries preview
verification.

Known limitations or unverified areas: None.

Rollback commit, forward version, and procedure: Revert this commit to restore
`allApprovedRuntimeMax` to 11200000. No runtime effect — the gate simply tightens again. Forward-only
recovery per `docs/operations/INCIDENT_RESPONSE.md` if ever needed.
