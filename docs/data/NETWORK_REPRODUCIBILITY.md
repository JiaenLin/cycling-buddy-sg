# Network data reproducibility

PCN and CPN originate from the named data.gov.sg dataset IDs in
`release/data-sources.json`. Rail Corridor production originates from the recorded OpenStreetMap
relation 3871697 snapshot; rebuilds audit the current relation and therefore expose subsequent OSM
edits as source-data deltas. Their licences, observed hashes, transformations, production
hashes, and known upstream deltas are locked in that file.

Run `npm run verify:data` for the offline production/provenance gate. To audit current upstream
data without touching production files, run:

```sh
npm run data:rebuild -- --download --output-dir .artifacts/data-rebuild
```

The command writes candidate layers and `rebuild-report.json` only below `.artifacts`. It never
overwrites `data/`. A changed source or output hash is expected when an agency edits its data; it
is a review input, not permission to update production. Adoption requires rendered geometry
review, source/licence review, count/bounds/distance deltas, fixed routing checks, a service-worker
version bump, and the release gates for the classified risk.

The normalization contract is deliberately shared and importable. It flattens multiline source
features in stable order, maps only reviewed public properties, uses deterministic
Douglas–Peucker simplification, rounds coordinates, and serializes without nondeterministic data.
