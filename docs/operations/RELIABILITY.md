# Reliability objectives and release decision

Cycling Buddy SG uses synthetic monitoring because collecting a cyclist's location, route, ride
trace, device fingerprint, or persistent identifier would create a disproportionate privacy risk.
The machine-readable objectives are in `release/reliability-objectives.json`; the complete field and
retention review is in `release/health-privacy.json`.

## Indicators

The stable URL is checked every six hours and before/after production promotion. A check records
only pass/fail, rounded duration, public release/channel, asset counts, public dependency status
classes, and finite diagnostic codes.

| Indicator | Good event | Objective over 28 days |
|---|---|---:|
| App load | Critical map layers initialize without a page or console error within 12 seconds | 99.9% |
| Required assets | Every manifest asset exists and matches its approved SHA-256 | 100% |
| Service worker | The approved worker installs, remains stable across repeated update checks, and has no update loop | 99.0% |
| Routing | The fixed public route fixture initializes and returns directions within 20 seconds | 99.0% |
| Client errors | Synthetic session produces no uncaught error | 99.9% |
| Live dependencies | OpenFreeMap style and NEA forecast endpoints return a usable response | 98.0% |

GitHub Actions workflow history is the availability event stream. JSON artifacts are the diagnostic
record. `node scripts/health-evaluator.mjs <report...>` evaluates one run or a window of reports.

## Alerts and error budget

A missing/hash-mismatched release asset, startup failure, service-worker failure/update loop,
routing failure, or uncaught error is a critical alert. One critical alert freezes non-incident
production releases. Two consecutive upstream warnings also freeze release. Consuming 50% of any
28-day error budget freezes feature releases until the signal is green, the cause is documented,
and a regression check is added or strengthened.

The scheduled workflow fails on any alert signal and retains the privacy-limited JSON artifact for
28 days. The window evaluator applies the separate release-freeze thresholds. GitHub Actions
notifications provide the owner alert path; an incident issue may contain only the approved finite
fields. Recovery and escalation follow
`docs/operations/INCIDENT_RESPONSE.md`.

## Evaluation commands

```text
npm run health:production
node scripts/health-evaluator.mjs .artifacts/production-health.json
npm run verify:unit
```

Use `node scripts/health-evaluator.mjs --simulate missing-asset` to prove the critical alert path
without changing production.
