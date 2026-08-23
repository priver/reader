# Testing

This document specifies the target test strategy and release gates through invitation beta. The
current packages do not yet implement the full test stack.

## Merge gate

Before merge, every change to `main` must pass all applicable checks:

- Formatting
- Type checking
- Type-aware linting
- Generated artifact drift
- Go unit tests
- PostgreSQL integration tests
- Frontend unit and component tests
- Critical Playwright flows
- Production builds
- Browser-release manifest and asset-inventory validation
- Go vulnerability analysis
- Dependency and container scanning

Once the root `justfile` exists, use it to find commands. Until then, use package scripts and the
current root `pnpm check` and `pnpm build` commands. Keep command definitions in executable
configuration instead of copying the full recipe list into this document.

## Test layers

### Go unit tests

Test deterministic domain behavior without network or database dependencies:

- Feed refresh interval calculation
- Failure backoff and cooldown
- Feed URL classification, canonicalization, redirect identity, and endpoint deduplication
- Feed-scoped entry identity
- Read watermark and exception transitions
- Retention decisions
- Invitation request deduplication, resolution, and 30-day expiry
- Invitation issuance, seven-day expiry, and redemption rules
- imgproxy URL signing
- Content-envelope version handling

### Go integration tests

Run against a real supported PostgreSQL service in CI.

Cover:

- Goose migrations from an empty database
- sqlc queries and ownership scoping
- River enqueue, uniqueness, retry, and leader behavior
- Subscription and folder constraints
- Sparse read state and bulk watermark updates
- Saved-item retention
- Account deletion
- Invitation request uniqueness, approval, and email-job enqueueing
- Audit append behavior
- Object metadata coordination and cleanup recovery

Prefer a CI PostgreSQL service or disposable container to mocks of PostgreSQL semantics.

### Feed and content tests

Use versioned local fixtures. Test runs must not depend on live publisher websites.

The fixture corpus includes:

- RSS 0.9x, 1.0, and 2.0 variants used in practice
- Atom 0.3 and 1.0 variants used in practice
- Missing IDs, duplicate IDs, changing IDs, and duplicate links
- Invalid dates and mixed date formats
- Character encodings and malformed XML seen in real feeds
- Relative links and image URLs
- Namespaced extension fields
- Empty, summary-only, and full-body entries
- Multilingual and bidirectional content
- Malicious and malformed HTML
- Oversized and redirecting responses
- Image URLs targeting rejected address ranges

### Entry and content fixture contract

Issue #31 creates the redistributable fixture files and issue #7 runs them. The cases and expected
results below are the versioned contract; replacing a parser, sanitizer, JSON canonicalizer, or gzip
writer must not change them without a new contract version and migration plan.

#### Identity and duplicates

Every identity fixture asserts the complete `v1:<tier>:sha256:<lowercase-hex>` key, not only whether
two items compare equal.

- Two Atom entries with one `<id>` and different valid `updated` values collapse to the later
  revision. Reversing document order produces the same metadata, body, and content version.
- Two RSS items with one `<guid>` and tied or invalid dates use the lexicographically smallest
  normalized-representation digest. Reversing order produces the same winner.
- Missing IDs with links that differ only by normalized scheme or host case and a matching default
  port collapse. Links with different fragments remain distinct.
- Distinct publisher IDs with one link remain distinct. One publisher ID with changed link, title,
  or body updates one Entry.
- Changing publisher ID A to B creates a new Entry even when the publisher link stays fixed.
- Missing ID and link with a stable normalized title and publication time updates one Entry when its
  body changes.
- An item with no ID, link, or valid title-plus-publication pair uses the source fingerprint. A body
  change at this tier creates a new Entry.
- Whitespace-only and over-4,096-byte IDs fall through. Invalid dates do not participate. A fully
  empty item is rejected rather than receiving fetch-time or position identity.
- Golden keys cover RSS GUID, Atom ID, relative and fragment links, Unicode NFC and whitespace title
  normalization, invalid dates, and the source-body fallback.

A Feed-merge fixture contains one colliding publisher key, one source-only key, one target-only key,
and two distinct IDs sharing one link. The target Entry survives the collision, source-only entries
move, different keys remain separate, and the duplicate winner is independent of processing order.
Saved flags combine with OR, explicit unread wins over read, progress keeps the furthest value, and
last-opened time keeps the latest value.

#### Publisher updates

- First observation starts at content version 1. Replaying the same normalized representation or
  changing only XML formatting keeps version 1 and does not write another current object.
- A title, author, valid update time, sanitized body, image source, lead image, or alt-text change
  moves the version to 2. Replaying that payload remains at 2.
- Golden tests pin the exact RFC 8785 representation bytes and SHA-256 used for duplicate selection
  and content-version comparison.
- A script or stripped publisher attribute change that leaves sanitized output identical does not
  increment the version.
- A to B to A produces content versions 1, 2, and 3 rather than reusing 1.
- A pure envelope-structure or compression migration preserves the version when browser output is
  identical. A sanitizer migration that changes output increments it.
- Duplicate candidates and failed publication retries never skip, decrement, or publish an
  unverifiable version.
- A synthetic maximum-version case refuses overflow beyond 9,007,199,254,740,991.

#### Envelope and malformed content

A golden envelope combines relative links, repeated image URLs with different alt text, Unicode and
bidirectional text, and an item-level lead image. It pins all of these outputs:

- Final sanitized HTML and deterministic plain text
- `content`, `summary`, and `empty` body-source variants
- Exact `reader-image` tokens, manifest order, IDs, source URLs, alt text, and lead ID
- RFC 8785 canonical JSON and lowercase integrity SHA-256 with `integrity` omitted from hash input
- Gzip level 6 bytes with zero modification time, OS 255, and empty optional header fields

Malicious and malformed HTML fixtures remove scripts, styles, event handlers, forms, iframes,
publisher tracking attributes, injected `reader-image` elements, and injected `data-image-id`
attributes. Private-literal, user-information, non-HTTP, malformed, and over-4,096-byte image URLs
do not enter the manifest; escaped non-empty alt text remains in the body and plain text.

Decoder fixtures reject:

- Truncated, invalid, or over-limit gzip data
- Malformed I-JSON, duplicate properties, unknown required enums, and unsupported schema versions
- Wrong integrity algorithm or digest
- Duplicate or missing manifest IDs, unknown or repeated body placeholders, and orphan body items
- Missing or invalid lead references and rejected manifest source URLs

Compatibility fixtures run an overlap reader against the old and current envelope versions, prove
that the old reader never receives new-version writes, and backfill ordinary and saved objects. They
assert that structural rewrites preserve content version while visible output changes increment it,
and that the old object remains readable through the recovery window.

### Feed URL fixture contract

The backend URL package and safe HTTP client must implement the following table-driven cases with a
fake resolver and dialer. Tests never contact publisher sites, public DNS, or cloud metadata
services.

Canonicalization cases:

- Scheme and host case fold to lowercase. Unicode and A-label host spellings converge.
- A DNS root dot and matching default port disappear. An empty path becomes `/`, and a fragment
  disappears.
- Username, password, username-only, non-HTTP scheme, relative URL, opaque URL, missing host,
  malformed port, zone-scoped IPv6, embedded controls, and over-limit input fail.
- `http` versus `https`, path case, trailing slash, repeated slash, dot segment, escaped-octet
  spelling, non-default port, query order, duplicate query values, and an explicit empty query
  remain distinct.
- A public selector such as `?channel_id=UC123` and a token-looking `?token=example` are both
  preserved and receive the same public-only classification. This locks in the decision not to use a
  secret heuristic.

Redirect and deduplication cases:

- A `301` or `308` creates an alias and promotes the next permanent endpoint. A `302`, `303`, or
  `307` is followed for the request but does not create an alias.
- `300`, `305`, and every other 3xx response outside the allowed set are terminal and are not
  followed.
- `A --301--> B --302--> C` makes B canonical and keeps C request-local.
- Relative `Location` resolution passes through canonicalization.
- A redirect loop, sixth hop, malformed target, user-information target, unsupported scheme, or
  non-public target fails.
- A normalized URL or permanent alias reuses an existing Feed. A permanent redirect to an owned
  target selects the target Feed and produces one idempotent merge.
- Temporary redirects, Atom `rel=self`, identical payloads, DNS aliases, path variants, and
  reordered queries do not merge Feed records.

SSRF cases:

- Reject IPv4 unspecified, loopback, RFC 1918, link-local, carrier-grade NAT, documentation,
  benchmarking, multicast, reserved, and cloud metadata destinations.
- Reject IPv6 unspecified, loopback, IPv4-mapped rejected addresses, unique-local, link-local,
  documentation, multicast, and zone-scoped destinations.
- Reject `localhost` and ambiguous integer, octal, or hexadecimal IPv4 host spellings.
- Reject a DNS answer set containing any non-public address, a public first answer followed by a
  private rebinding answer, and every redirect from a public origin to a rejected destination.
- Accept synthetic globally routable IPv4 and IPv6 results through the fake resolver and pinned
  dialer.

Store only fixtures that the project can redistribute. Create a minimal reproduction when a real
response cannot be committed safely.

### Frontend tests

Use the Vite-compatible unit test runner selected during implementation and React testing tools.

Cover:

- List and reader state transitions
- Optimistic read, save, progress, and undo behavior
- Router search state and filter persistence
- Cursor pagination and virtualization boundaries
- Three-pane resizing and persistence
- Mobile navigation and gestures
- Theme and reduced-motion behavior
- Accessible names, focus order, and keyboard operation
- Safe article rendering and click-to-load placeholders
- Dynamic import and font URLs on the configured cookieless origin
- Signed article and thumbnail image URLs on `reader.mprvr.net/images/`

Do not snapshot entire pages. Assert behavior, semantics, and stable component output.

### Browser release tests

Build both browser applications in release mode and verify:

- Every HTML, stylesheet, and dynamic-import reference resolves to an object in its release
  manifest.
- Asset keys derive from file contents and do not contain the release ID.
- Rebuilding unchanged input preserves unchanged asset URLs.
- End-user assets use `reader.mprvr.net`; admin assets use `reader-admin.mprvr.net`.
- Admin assets are reachable through the admin Bastion path and unavailable through public
  listeners.
- Unsigned release HTML and asset reads work through the configured VPC service connection and fail
  from the public network or another service connection. Browser manifests and every other key deny
  unsigned reads.
- The publisher uploads all assets before HTML and refuses to replace a key with different bytes.
- Publisher and cleanup identities can perform only their allowed actions and prefixes through the
  configured service connection; the same authenticated requests fail through any other endpoint.
- Publication and cleanup cannot hold the release-maintenance lock concurrently. An interrupted
  publication never exposes HTML before its manifest and assets, and a concurrent cleanup never
  deletes an asset selected by the publisher.
- Reference-aware cleanup preserves assets used by any retained, active, or rollback manifest.
- Clock-controlled cleanup tests retain superseded manifests and their assets for 45 days, make
  unreferenced objects eligible only afterward, and protect active and rollback references
  regardless of age.
- Missing assets return `404` and never return an SPA document.

### End-to-end tests

Use Playwright to run critical browser workflows against the composed stack with real Kratos and a
local mail sink such as Mailpit.

Critical flows:

- Email-code login
- Passkey enrollment and preferred passkey login
- OPML import
- OPML export
- Add feed by direct URL and website discovery
- Folder organization
- Unread reading loop
- Save, progress, resume prompt, and cross-session state
- Scoped mark-read and undo
- Search by title and source
- Account deletion
- Public invitation request, admin approval, delivery, and redemption in beta
- Admin passkey and direct invitation flow in beta
- A release-A tab loads a previously untouched lazy chunk after release B is promoted and the blue
  VM is removed

Use browser virtual authenticators for passkey automation. Maintain one manual device matrix for
platform authenticator behavior that automation cannot represent accurately.

## Browser matrix

Support the latest two stable releases of:

- Chrome desktop
- Safari desktop
- Firefox desktop
- Mobile Safari
- Android Chrome

Run the complete E2E suite on a primary browser and a smaller critical-flow matrix on the remaining
engines. The smaller matrix includes cross-origin module, stylesheet, and font loading from both
static origins. For a passkey or sanitizer change, expand the relevant matrix.

## Accessibility

WCAG 2.2 AA is a release criterion.

Automated checks must cover semantics, accessible names, common contrast failures, and focusable
controls. Manual checks must cover:

- Full keyboard reading workflow
- Visible focus across all panes
- Screen-reader landmarks and announcements
- 200% text scaling
- Responsive reflow
- Reduced motion
- Light and dark contrast
- Touch target size

Automated accessibility checks do not replace the manual checks.

## Security tests

Maintain explicit regression suites for:

- DNS rebinding and redirect SSRF
- IPv4 and IPv6 private, loopback, link-local, and metadata addresses
- Compressed response expansion
- XML and HTML parser limits
- Sanitizer XSS and DOM-clobbering cases
- imgproxy signature changes and preset tampering
- Image bombs, oversized files, redirects, and SVG scripts
- CSRF and ownership violations
- Invitation request enumeration, duplication, and rate-limit bypass
- Invitation replay and expiry
- Identity-linking confusion
- Admin authorization and audit coverage
- Host-only public and admin session cookies that never reach either static origin
- Exact-origin, noncredentialed CORS on both static origins
- CSP separation between end-user and admin static origins
- Static-origin host routing, object-key traversal, encoded separators, and credential stripping
- Private admin-bundle reachability through Bastion, denial through public listeners, and absence of
  source maps or secrets
- Direct Network Load Balancer denial for public app, asset, and image routes without Cloudflare
  origin authentication
- Separation of `reader.mprvr.net/assets/` and signed `reader.mprvr.net/images/` routing
- Cookieless image requests and stripped credentials before Nginx cache and imgproxy
- Object Storage strict mode, private-endpoint policy conditions, TLS-only reads, and denial of
  anonymous list, write, and delete operations
- Authenticated API and worker content operations through the private endpoint, denial of unsigned
  content reads, and denial of authenticated operations through the public endpoint or another
  service connection
- API denial of content list, write, and delete operations; worker denial of content list and bucket
  administration; and denial of every out-of-prefix operation
- Nginx denial from cloud metadata, Lockbox, content objects, browser manifests, and authenticated
  release operations
- Stale-release 45-day boundaries, active and rollback overrides, and missing-asset `404` behavior
- Telemetry redaction

Fuzz feed parsing, HTML normalization, URL validation, and content-envelope decoding if the chosen
libraries expose stable fuzz entry points.

## Generated artifacts

Commit generated TanStack route trees, OpenAPI Go interfaces, TypeScript clients, and sqlc query
code according to the convention of each owning tool.

CI must:

1. Regenerate every artifact from source definitions.
2. Run formatters required by the generator or language.
3. Fail if the worktree differs.

Never fix generated output manually.

## Performance and load gates

Before invitation beta, test the complete scale model defined in
[`architecture.md`](architecture.md#scale-and-quality-targets) without a redesign. Seed
representative metadata and content bodies for the full durations defined in
[`data-model.md`](data-model.md#retention).

Gates:

- The freshness and due-job-lag definitions in [`architecture.md`](architecture.md#scheduling-terms)
  both pass; one cannot mask failure in the other.
- The cached interactive API latency target in
  [`architecture.md`](architecture.md#scale-and-quality-targets) passes from `ru-central`.
- Queue lag returns to steady state after a simulated publisher or network outage.
- Retention cleanup does not block normal reads or ingestion.
- Nginx and imgproxy remain within configured disk, memory, worker, and queue limits.
- Nginx, the Object Storage service connection, and Cloudflare meet the public asset and image
  latency targets selected during production sizing without elevated missing-object responses.
- The private admin asset path meets its latency target through Bastion without relying on
  Cloudflare.

Use synthetic origins and the fixture corpus for load tests. Do not turn public publishers into load
test targets.

## Recovery tests

Before beta and after material storage changes:

1. Restore Managed PostgreSQL to a new cluster from a selected point in time.
2. Reconnect a disposable application color with least-privilege credentials.
3. Verify Object Storage references and saved-body availability.
4. Republish or reconnect the active end-user and admin browser releases from their signed manifests
   and verify end-user imports through Cloudflare and admin imports through Bastion.
5. Verify the restored color resolves Object Storage through the allowed VPC service connection.
6. Verify Kratos login and application identity mapping.
7. Measure recovery against the targets in [`deployment.md`](deployment.md#backups-and-recovery).

Record the drill date, duration, gaps, and corrective actions.

## Completion criteria

A test change is complete when:

1. Every changed invariant has coverage at its lowest reliable layer.
2. Every fixed external-input bug has a committed fixture or minimal reproduction.
3. Critical user behavior remains covered end to end.
4. Supported-browser and accessibility effects are evaluated.
5. Generated artifacts and target documentation agree with the implementation.
