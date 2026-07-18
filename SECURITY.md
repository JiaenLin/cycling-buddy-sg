# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's **Security** tab and
select **Report a vulnerability** to create a private GitHub Security Advisory. Include affected
release/commit, reproduction steps, impact, and whether location or ride data may be exposed.

The owner will acknowledge a credible report within 3 calendar days, triage severity within 7 days,
and coordinate disclosure after a fixed release is available. An actively exploited issue follows
the SEV-1 path in `docs/operations/INCIDENT_RESPONSE.md`.

## Supported version

Only the current production commit and the immediately previous service-worker release receive
security fixes. Rollback is always forward-versioned so already installed clients do not become
trapped on a compromised cache version.

## Scope and privacy

The PWA has no account system or backend. Location and ride traces are processed in the browser and
must not be included in reports unless the reporter has replaced them with synthetic fixtures.
