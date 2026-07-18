# Content Security Policy assessment

GitHub Pages does not provide a repository-controlled HTTP report-only CSP header. A meta policy can
enforce most directives but cannot provide safe report-only deployment and must appear before every
resource. Enforcing an untested meta policy could disable MapLibre workers or map styles, so CSP is a
Tier 3 change and is not added incidentally.

## Candidate policy

```text
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https:;
font-src 'self' data: https://tiles.openfreemap.org;
connect-src 'self' https://tiles.openfreemap.org https://api-open.data.gov.sg
  https://cycling-buddy-sg.goatcounter.com;
worker-src 'self' blob:;
manifest-src 'self';
object-src 'none';
base-uri 'none';
form-action 'none';
frame-ancestors 'none';
upgrade-insecure-requests
```

`style-src 'unsafe-inline'` is currently needed by MapLibre-generated element styles and existing
popup colour swatches. `worker-src blob:` is required by MapLibre. `img-src https:` is broader than
ideal because the style can refer to tile/sprite hosts. Before enforcement, inventory the resolved
OpenFreeMap style hosts, replace inline first-party style attributes where practical, test map worker,
light/dark styles, tiles, glyphs, weather, analytics, offline install and update on preview, then use
an HTTP host with report-only support or deploy the meta policy for a dedicated canary first.

Until then, the strongest controls are self-hosted scripts, no arbitrary remote HTML, output encoding,
vendored checksums, dependency/code scanning and exact-commit deployment. The accepted CSP gap is
recorded in `release/security-review.json` and reviewed quarterly.
