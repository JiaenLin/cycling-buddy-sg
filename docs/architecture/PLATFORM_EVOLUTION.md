# Platform evolution

The current PWA remains the stable product. Native apps or an outdoor-platform edition should not
fork routing rules, data semantics, privacy behavior, or release evidence. They should consume a
portable core behind the versioned contracts in `contracts/v1` and supply platform adapters.

The intended boundary is:

```text
versioned data + route contracts
              |
       portable domain core
              |
  web adapter | native adapter | outdoor-device adapter
```

The portable core owns route profiles, cost semantics, normalized network models, closure rules,
and deterministic fixtures. Adapters own rendering, geolocation permission UX, offline storage,
background execution, network reachability, weather, export/share, and platform lifecycle. No
adapter may weaken the local-only location default.

Evolution should be incremental:

1. Wrap the existing router behind the v1 request/result adapter and keep byte-for-byte fixtures.
2. Extract pure routing and data-validation modules without changing web behavior.
3. Add a native or outdoor adapter in a separate package, reusing the same contract fixtures.
4. Introduce sync, accounts, background location, or notifications only as separate Tier 3
   capabilities with consent, retention, threat-model, deletion, battery, and recovery reviews.

Outdoor development additionally needs offline-first startup, sunlight/high-contrast controls,
glove/rain-friendly targets, low-power tracking, interrupted-recording recovery, stale-data age,
thermal/battery testing, and a clear degraded mode. Those are future release gates, not claims
about the current PWA.

Contract compatibility is additive within v1. A removed field, unit change, altered route-profile
meaning, or storage migration requires v2 plus old-to-new fixtures. Production data remains
immutable input to release candidates; apps may package or download it, but must verify the same
published hashes and schema version.
