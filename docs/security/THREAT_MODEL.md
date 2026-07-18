# Threat model and data-flow review

Last reviewed: 2026-07-18. Review this document for every Tier 3 change and after any new app,
account, sync, cloud, wearable, sensor, or outdoor-platform capability is proposed.

## Assets and privacy promises

- Availability and integrity of the application shell, routing graph and public geospatial data.
- Correct avoidance of expressways and honest warnings when a route uses roads or closures.
- Browser geolocation, current ride trace and exported GPX. These remain on the device and are not
  sent to Cycling Buddy SG or GoatCounter.
- Service-worker update integrity: an installed cyclist must not receive a mixed-version shell or
  be reloaded unexpectedly during a ride.
- Source, licence and attribution integrity for public datasets and vendored code.

## Data flow and trust boundaries

```text
GitHub repository --reviewed immutable commit--> GitHub Pages / production branch
        |                                             |
        |                                             v
        +--> GitHub Actions checks              Browser + service worker
                                                      |
                  +-------------------+---------------+------------------+
                  |                   |                                  |
                  v                   v                                  v
          OpenFreeMap tiles    data.gov.sg forecast         GoatCounter page count
          viewed tile area     generic islandwide API       page metadata, no ride trace

Browser geolocation --> in-memory map/route/recording --> local GPX download
                                      (no project server, account or cloud sync)
```

Map tile requests necessarily reveal the viewed tile area to OpenFreeMap. The live forecast request
is the same generic islandwide request for every user; the nearest zone is selected locally. A GPX
is generated as a local download. The app has no ingestion API, database, login, advertising SDK,
or background location upload.

## Primary threats and controls

| Threat | Impact | Existing control | Required delta for future platform work |
|---|---|---|---|
| Compromised commit or workflow | Malicious app/data release | PR-only main, required checks, no bypass, exact-SHA preview/production, pinned actions | Signed mobile artifacts, protected app-store credentials and two-person production approval |
| Compromised dependency/vendor file | Script execution in browser | No runtime package manager, local vendor hashes, dependency review, CodeQL, Dependabot | SBOM and signature/provenance verification for native packages |
| Malicious/unescaped dataset text | Stored XSS in popups | Curated schemas, `esc()` before HTML interpolation, deterministic validation | Treat remote platform content as hostile and require schema plus output encoding at every surface |
| Mixed/stale service-worker shell | Broken/offline client or update loop | Versioned complete precache, no automatic waiting-worker activation, exact asset manifest, recovery drill | Versioned API/data migrations and backward compatibility across supported app releases |
| Route safety regression | Cyclist directed onto unsafe/inaccessible route | Expressway exclusion, fixed route fixtures, road warning, closure layers, Tier 3 gate | Independent routing-core package, route-contract corpus and field validation |
| Location/ride disclosure | Physical privacy and safety harm | Local-only processing and export, synthetic monitoring, no identifiers | Explicit opt-in, minimisation, encryption, deletion/export controls and DPIA before any sync feature |
| Third-party outage | Map/weather degradation | Offline shell/data, synthetic monitoring, weather fail-closed behaviour | Provider abstraction, documented degraded modes and multi-provider strategy where justified |
| Denial of storage through tile cache | Offline failure/device pressure | 800-entry tile cap and versioned cache cleanup | Quotas per platform adapter and storage-pressure telemetry that contains no user content |

## Tier 3 review questions

The update report must state: changed trust boundary; new data collected/transmitted/stored; new
permission; new dependency/provider; authentication/secret requirement; retention/deletion; abuse
case; rollback/migration path; and the exact automated/manual checks added. Any unexplained answer is
stop-ship.

## Future native app and outdoor platform boundary

No account, cloud sync, community feed, emergency feature, health sensor, or background tracking may
reuse the PWA's current low-risk privacy claim. Each requires a separate approved threat-model
section, data-flow diagram, retention schedule, platform permission review and incident owner before
implementation. See `docs/architecture/PLATFORM_EVOLUTION.md`.
