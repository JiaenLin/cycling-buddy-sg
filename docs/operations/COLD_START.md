# Cold-start build and release runbook

The purpose of this runbook is bus-factor: a second engineer, starting from nothing but this
repository and the public data sources, can build the app, verify it, and take a change to
production without private knowledge. It is the operational companion to the private operating
guide; where they disagree, the machine-readable contracts win (see
[release/data-sources.json](../../release/data-sources.json) and the `release/*.json` gates).

This is a static, no-backend PWA. There is no server to provision — "build" means regenerating
data, and "release" means promoting an exact reviewed commit across GitHub Pages channels.

## 0. Prerequisites

- Node.js >= 22 and Python 3.13 (the deterministic gate checks build-script syntax with both).
- Git with push access to `JiaenLin/cycling-buddy-sg` (development `main`) and the preview repo.
- A modern Chromium/Firefox/WebKit for the browser gates (`npx playwright install --with-deps`).
- A real Android phone and iPhone for the physical update tests before any runtime Tier 3 release.

## 1. Get a working checkout

```bash
git clone https://github.com/JiaenLin/cycling-buddy-sg.git
cd cycling-buddy-sg
npm ci
```

Serve the app locally over HTTP (the service worker and geolocation need `localhost` or HTTPS):

```bash
node scripts/serve.mjs      # or: python -m http.server 8000
```

Open the printed URL, confirm the Singapore map, light/dark themes, and the PCN/CPN/parks/racks
layers render. This is the smoke check that the checkout is healthy before you change anything.

## 2. Rebuild data from source (only when refreshing data)

Raw source, transform code, generated output, and provenance stay distinct. Never hand-edit a
generated GeoJSON/JSON file — fix the generator and rebuild. The network build is documented in
[build/README.md](../../build/README.md); source identities, licences and freshness policy live in
[release/data-sources.json](../../release/data-sources.json).

```bash
npm run data:rebuild        # writes to a review directory, not production, until approved
npm run verify:data         # locks output hashes AND checks source age + closure validity
```

`verify:data` now fails a release when a source snapshot is older than its `failAfterDays` policy,
or when a closure has an expired end date or an overdue open-ended review. Bump `capturedOn` /
`closures.lastReviewedOn` in `release/data-sources.json` when you re-confirm a source.

## 3. Classify the change and verify

```bash
npm run risk:classify       # conservative file-based minimum tier; raise it if behaviour is riskier
npm run verify:deterministic # syntax, JSON, data, security, governance, performance — no browser
npm run verify:all          # the above plus browser, accessibility, performance and recovery
```

Read the actual diff and generated deltas, not just exit codes. For a runtime release, bump the
service-worker `VERSION` in `sw.js` **last** and re-run the gates.

## 4. Open a protected pull request

Branch from current `origin/main`, one coherent purpose per branch:

```bash
git switch --create agent/<short-purpose> origin/main
git add <explicit paths only>     # never stage private notes, artifacts, or unrelated edits
git commit
git push --set-upstream origin agent/<short-purpose>
```

Open a PR. Required GitHub checks (deterministic verification, browser/accessibility/performance/
recovery matrix, dependency review, CodeQL) must be green before merge. Merge through the active
`main` ruleset — do not bypass checks, force-push, or rewrite history.

## 5. Release an exact candidate (runtime changes)

Promotion moves one immutable commit across channels; nothing is rebuilt or hand-edited between
channels. The channel rules and soak windows are in
[RELEASE_CHANNELS.md](RELEASE_CHANNELS.md).

```bash
npm run release:manifest             # freeze a pending manifest for the exact candidate SHA
# fast-forward the exact SHA to preview, wait for Pages to report it, then:
npm run release:verify-deployment    # confirm every deployed asset hash matches the manifest
npm run health:production            # privacy-preserving synthetic health on the deployed URL
```

Complete the soak (runtime Tier 3 from v22 onward: at least 24 unchanged hours) and the physical
Android/iPhone update tests. Then, with owner approval naming the exact candidate SHA,
fast-forward that same SHA to `production` and re-verify assets and health live.

## 6. If something goes wrong

Never "roll back" by redeploying an old cache version. Restore known-good content in a new
forward commit with a higher service-worker version, verify the broken → recovery update, and
follow [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md). Record the cause, detection gap, and the
test/monitor that will catch it next time.

## 7. Growing beyond the PWA

New surfaces (native, outdoor devices) reuse the portable core through the versioned boundary in
[contracts/v1/](../../contracts/v1/): the route request/result schemas, closure validation, and
the capability declaration. `tests/node/contract-v1.test.mjs` pins those semantics so an adapter
cannot silently drift. Additive fields stay within v1; removing a field or changing its meaning
requires a new contract version and migration tests.
