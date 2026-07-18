# Incident response and forward recovery

Security reports use the private path in `SECURITY.md`. Availability, routing, update and data
integrity alerts use the synthetic health workflow or a GitHub issue. The repository owner is the
incident commander until another named maintainer explicitly takes the role.

## Severity and targets

| Severity | Example | Acknowledge | Contain | Recover |
|---|---|---:|---:|---:|
| SEV-1 | Malicious release, location/ride disclosure, widespread update loop, unsafe routing onto excluded road | 30 min | 2 h | 8 h |
| SEV-2 | Production will not load/install/route for a material share of users; required asset missing | 2 h | 8 h | 24 h |
| SEV-3 | Degraded weather/basemap, inaccurate non-safety metadata, isolated browser regression | 1 business day | 3 business days | Planned fix |

RPO is zero for repository releases and production data: every deployment is an immutable Git
commit and every approved asset is hashed. The app has no server-side user data. A recording exists
only in browser memory until local GPX export, so the update UI must remain unavailable during an
active recording.

## Response sequence

1. **Detect and declare.** Preserve alert/run URLs, production/preview/branch SHAs, service-worker
   version, HTTP headers, screenshots and affected browser/device. Never paste real coordinates or
   ride traces into an issue.
2. **Freeze.** Stop non-incident releases. Do not rewrite or delete the production commit/branch.
3. **Contain.** Disable an optional upstream feature only when a previously tested flag exists. For
   a bad release, prepare a new commit from the last known-good tree.
4. **Forward-version rollback.** Never redeploy an old service-worker version. Copy the last
   known-good runtime into a new commit, increment `VERSION`, run the full Tier 3 suite, deploy the
   exact SHA to canary, approve it, then fast-forward the protected production branch.
5. **Verify.** Confirm Pages SHA, every manifest hash, fresh install, installed-client update,
   offline shell, routing fixture, no controller loop and no loss of local settings/draft fixture.
6. **Communicate.** Update the incident issue at declaration, containment, recovery and closure.
   State user impact and workaround plainly; do not speculate.
7. **Learn.** Within 5 business days, record timeline/root cause/contributing factors. Add or
   strengthen a test, fixture, monitor or repository rule before closing the incident.

## Recovery drill

`tests/browser/sw-recovery.spec.mjs` serves the production service worker with three forward
versions: installed old, deliberately broken candidate (one required shell asset returns 503), and
forward-versioned recovery. It proves the failed candidate never activates, the old controller
continues, the recovery waits for user activation, local storage/IndexedDB survive, stale caches are
removed and repeated update checks do not loop.

```text
npm run verify:recovery
```

The latest result is recorded in `release/drills/2026-07-18-update-recovery.json`. Run this drill for
every service-worker contract change and at least annually.
