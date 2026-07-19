# Release channels

Development is mutable and never user-facing. The public preview site is the opt-in canary; it
receives an immutable candidate SHA after protected-main checks pass. Production receives that
same SHA by fast-forward only—never a rebuild or a hand-edited copy.

A Tier 3 candidate is deployed to preview as an immutable SHA and verified there — automated
checks plus a quick manual smoke test on a real phone (including the old→new update prompt) —
before the same SHA is promoted. There is no fixed soak clock: promote once preview verification
passes. Any freeze signal (failed check, asset mismatch, update loop, or a regression found on
preview) restarts the candidate after a new commit.

The machine-readable channel contract is `release/channels.json`. Preview participation is opt-in
by visiting its separate URL. It does not share a service-worker scope or storage with production.
