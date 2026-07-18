# Regression and near-miss learning

Record every escaped regression and every credible near miss in `release/regressions.json`. A
record is not closed by explanation alone: it must identify the signal that was absent and link a
new or strengthened automated test, fixture, monitor, or release rule. The governance audit blocks
records that lack this learning.

For an active user-impacting issue, follow the incident runbook first. Preserve timestamps,
candidate SHA, channel, browser/device, screenshots or logs that contain no personal route data,
and the recovery version. Add the learning record during the post-incident review.
