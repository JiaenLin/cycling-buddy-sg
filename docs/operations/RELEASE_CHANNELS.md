# Release channels

Development is mutable and never user-facing. The public preview site is the opt-in canary; it
receives an immutable candidate SHA after protected-main checks pass. Production receives that
same SHA by fast-forward only—never a rebuild or a hand-edited copy.

Tier 3 candidates remain on preview for at least 24 hours and require recorded physical Android
and iOS checks. Health signals, asset verification, routing fixtures, update behavior, privacy,
accessibility, performance, and security results must remain within their release thresholds.
Any freeze signal restarts the candidate process after a new commit; elapsed time from a failed
candidate does not count toward the replacement candidate's soak.

The machine-readable channel contract is `release/channels.json`. Preview participation is opt-in
by visiting its separate URL. It does not share a service-worker scope or storage with production.
