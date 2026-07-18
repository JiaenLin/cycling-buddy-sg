# Performance budgets

The machine-readable limits are in `release/performance-budgets.json`. CI uses a named Pixel 7-class
profile with 4× CPU slowdown and deterministic Fast 4G network conditions. Basemap and weather are
mocked so results measure the release artifact rather than an upstream provider.

The cold startup budget covers application readiness and Core Web Vitals. Cold routing includes the
lazy 7.5 MB graph transfer; warm routing measures computation after that graph is in memory. Static
budgets cover every release-manifest asset, the eager offline shell, vendored code, first-party
JavaScript and the service-worker tile-entry cap.

```text
npm run verify:performance
npm run verify:performance:browser
```

CI failure is stop-ship. A budget may not be raised in the same change that exceeds it. The owner
must review a separate report containing before/after measurements, device/network profile, user
impact and rollback. Native app and outdoor-platform surfaces must add their own startup, battery,
background-location, storage and network budgets before implementation.
