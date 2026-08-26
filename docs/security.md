# Security

This document defines the target trust boundaries and security rules through invitation beta.
Reader's hobby-scale beta does not claim formal compliance certification or operation as a regulated
service. These engineering requirements and release gates still apply in full.

## Threat boundaries

Reader processes hostile XML, HTML, URLs, and images from arbitrary public publishers. Treat every
publisher response as untrusted even when another user has already subscribed to the same source.

Primary boundaries:

- Browser to same-origin Nginx, API, and Kratos routes
- Browser to the cookieless end-user and admin static origins
- Go feed fetcher to public network
- Go normalizer to stored article HTML
- Public `reader.mprvr.net/images/` request to Nginx and private imgproxy
- Application API and worker to private Object Storage
- Temporary disaster-recovery inventory access to private content Object Storage
- Nginx through the VPC Object Storage service connection to browser-release storage
- Reader session to private admin authorization
- Application telemetry to Yandex, the Sentry Free plan, and PostHog

## Feed network policy

The Go worker is the only application component that fetches feeds or website HTML for feed
discovery. Both paths use the same safe HTTP client and address policy.

Allow:

- Public `http` and `https` URLs
- At most five standards-compliant redirects that remain public
- Conditional HTTP requests

Reject:

- URL user information and separately supplied feed credentials
- Non-HTTP schemes
- Loopback, link-local, multicast, private, and cloud metadata addresses
- Private answers returned after DNS rebinding
- Redirects to a rejected address or scheme
- Responses above the configured decompressed limit

### Feed URL policy

Use one server-owned canonicalizer for direct feed and website input, OPML feed URLs,
website-discovery candidates, redirect targets, and stored endpoint lookup. Trim leading and
trailing ASCII whitespace. Reject embedded whitespace or controls and reject input longer than 4,096
UTF-8 bytes before or after canonicalization. URLs must be absolute and hierarchical, use `http` or
`https`, have a valid host and port, and contain no URL user information or IPv6 zone identifier.

Canonicalization lowercases the scheme and DNS host, converts internationalized hostnames with the
IDNA lookup profile, removes the DNS root dot, serializes IP literals canonically, removes ports 80
and 443 only for their matching schemes, removes the fragment, and changes an empty path to `/`.
Preserve the scheme, non-default port, path case and spelling, trailing and repeated slashes, dot
segments, escaped-octet spelling, and raw query. Query order, duplicate keys, blank values, and an
explicit empty query remain significant.

Reader cannot reliably distinguish public selectors from secrets in arbitrary paths and queries. It
therefore treats every accepted path and query as public endpoint identity and does not use
parameter names or apparent entropy as a secret detector. The add-feed flow warns that Reader may
store and reuse the complete URL and feed data across accounts that submit the same endpoint. Users
must not submit signed, tokenized, invitation-only, or otherwise confidential URLs.

Shared Feed records are not publicly discoverable. Return feed URLs only to subscribed users and
authorized administrators. Keep them out of general logs, telemetry, support diagnostics, and error
aggregation. These access limits reduce accidental disclosure but do not make capability URLs a
supported private-feed mechanism. The complete decision lives in
[`0007-feed-url-policy.md`](decisions/0007-feed-url-policy.md).

### Address and redirect validation

Validate every DNS answer and every redirect target, not only the initial URL. Reject a hostname if
any answer is non-public. Pin each connection to an address from that validated answer set so DNS
rebinding cannot trigger an unchecked lookup. Reject ambiguous integer, octal, and hexadecimal IPv4
host spellings. Pair application validation with host firewall rules that block metadata addresses
and destinations the service never needs.

Follow only `301`, `302`, `303`, `307`, and `308` responses. Treat every other 3xx response as a
terminal fetch outcome. Resolve a relative `Location` against the current response URL and rerun
URL, DNS, and address validation before following it. Fail closed on a redirect loop, a sixth
redirect, a missing or malformed target, URL user information, an unsupported scheme, or a
non-public destination. Do not forward origin-specific conditional headers across publisher
hostnames. Reader never sends user credentials on a redirect.

A leading chain of `301` and `308` responses may update a Feed's canonical fetch endpoint and retain
the old endpoints as permanent aliases. After the first `302`, `303`, or `307`, that target and all
later targets in the request are temporary and cannot change Feed identity.

Initial limits:

| Limit                                      | Value                                                                |
| ------------------------------------------ | -------------------------------------------------------------------- |
| Feed response                              | 5 MiB after decompression                                            |
| Concurrent requests per publisher hostname | 2                                                                    |
| Redirects                                  | 5                                                                    |
| Request duration                           | Bounded; exact connect and total timeouts set with production sizing |

Honor `Retry-After`, send a clear Reader user agent with a contact URL, and apply exponential
backoff after failures. Manual refresh uses the same queue and network policy.

Reader does not fetch linked article pages through beta.

Website discovery accepts only bounded HTML responses. It limits redirects and discovered
candidates, and never executes publisher scripts. Set the exact discovery byte and candidate caps
during implementation, then lock them with tests. These caps cannot exceed the feed-fetch response
cap.

## OPML import

Treat uploaded OPML as hostile XML. Accept only an uncompressed document of at most 5 MiB, at most
10,000 XML elements, at most 5,000 `<outline>` elements, at most 1,000 outlines with a nonempty
`xmlUrl`, and an XML element nesting depth of at most 32 below `<body>`. Require one unqualified
`<opml>` root with exactly one direct `<body>`. Reject the whole document before scheduling network
work when any limit is exceeded, XML is malformed, or the root or body is invalid. The XML parser
must reject DTDs, custom general or parameter entity declarations, and XInclude while retaining
XML's predefined entities; it performs no file or network resolution.

Unknown elements and attributes may be ignored only while all limits continue to count them. Bound
stored and returned error details to the first 100 occurrence-level or Feed-level item failures in
source order, with aggregate counts for the remainder. Every accepted `xmlUrl` then uses the normal
feed URL, SSRF, redirect, response-size, timeout, and publisher-concurrency policy. An OPML upload
never grants a different network capability from direct feed addition.

Allow at most one resolving or finalizing import run and five OPML upload attempts per user in a
rolling hour. A transport retry carrying the same upload idempotency key returns the same run and
does not consume another allowance. Apply the ordinary authenticated mutation and request-body rate
limits in addition to these caps.

## Feed HTML pipeline

Stored article bodies come only from RSS or Atom fields.

Process in this order:

1. Parse fragment HTML with `golang.org/x/net/html`.
2. Resolve relative links and images against the entry or feed base URL.
3. Remove publisher-supplied `reader-image` elements and reserved `data-image-id` attributes.
4. Normalize supported semantic markup.
5. Replace accepted images with app-owned placeholders and a normalized public image manifest.
6. Replace approved beta embeds with inert app-owned placeholders.
7. Apply the strict Bluemonday allowlist as the final transformation.
8. Derive plain text from sanitized output and normalized image alt text.
9. Canonicalize, integrity-hash, and deterministically gzip the versioned envelope.
10. Publish only after the worker reads the stored version back through the private endpoint and
    completes the strict checks below.

Bluemonday performs the last transformation that accepts publisher-controlled markup. At response
time, the API may replace typed app-owned image placeholders with generated `<picture>` markup. That
expansion accepts only normalized manifest fields and fixed server presets. It never copies
publisher HTML or attributes into the response.

The only body image token is `<reader-image data-image-id="image-N"></reader-image>`. Number tokens
in document order and require each ID to resolve to exactly one `{id, source_url, alt}` manifest
item. The normalizer accepts only absolute public `http` and `https` image URLs of at most 4,096
UTF-8 bytes without user information. It preserves non-empty escaped alt text when rejecting an
image. Durable manifests contain no cookies, request headers, signed paths, or unsanitized
attributes. Envelope v1 does not trust or store publisher-declared image dimensions.

The API bounds gzip decompression before allocation, rejects duplicate JSON properties and
unsupported schema versions, verifies the envelope SHA-256 over RFC 8785 canonical data, and checks
placeholder, lead-image, and URL invariants before caching or rendering. An unknown placeholder,
orphaned body manifest item, invalid lead reference, rejected source URL, or integrity mismatch
fails closed. It never falls back to rendering stored HTML from an unverifiable envelope.

The worker uses the same strict decoder on a full Object Storage GET before publication. It also
checks the compressed length and SHA-256, exact Object Storage version ID, proposed content version,
and normalized-representation digest reconstructed with staged Entry metadata. A successful PUT,
HEAD, ETag, or provider checksum does not authorize publication.

Alpha allows semantic static HTML and proxied images. The sanitizer removes scripts, forms, inline
styles, event handlers, iframes, objects, embeds, and publisher tracking markup. In beta, trusted
embeds use click-to-load application components. Reader does not preserve publisher iframes.

The browser never receives unsanitized feed HTML.

## Browser content policy

- Enforce a restrictive Content Security Policy.
- Use Trusted Types for article HTML sinks where browser support allows.
- Render sanitized HTML in the application document; do not rely on iframe sandboxing as the primary
  sanitizer.
- Permit proxied article and list images only from `reader.mprvr.net/images/` and bundled images
  only from the configured end-user or admin asset origin.
- Permit end-user scripts, styles, fonts, and bundled images only from `reader.mprvr.net`; permit
  the admin equivalents only from `reader-admin.mprvr.net`.
- Permit frames only for explicit click-to-load trusted providers in beta.
- Open external links with `noopener` and `noreferrer`.
- Keep API and Kratos browser flows same-origin on each public or private SPA vhost to avoid broad
  CORS policy.
- Send static asset requests without credentials. Each static origin allows only its application
  origin through CORS and never enables credentialed CORS.
- Send image requests to `reader.mprvr.net` without credentials.

Generate the exact CSP from implemented dependencies and verify it in browser tests. Do not copy a
permissive development policy into production.

## Edge and origin

- Accept public application, end-user asset, and image traffic through Cloudflare only.
- Restrict public Nginx ingress to current Cloudflare source ranges where the Yandex network path
  permits it.
- Require Cloudflare Authenticated Origin Pulls or an equivalent mTLS client check at Nginx.
- Expose Network Load Balancer health checks through a separate narrowly scoped path.
- Reject direct requests that cannot authenticate as Cloudflare, even when they reach the stable
  origin address.
- Use strict TLS from browser to Cloudflare and Cloudflare to Nginx.
- Validate the `Host` header before routing. Reject `admin.reader.priver.org` and
  `reader-admin.mprvr.net` on every public listener.
- Expose both admin hostnames only on the private Nginx listener reached through Yandex Bastion.
  Cloudflare does not proxy either hostname.

## Object Storage authorization

- Restrict the content, end-user release, and admin release buckets at the service level to the
  configured VPC Object Storage service connection. Disable public-network and management-console
  access.

Apply these authenticated permissions. Condition every permission on TLS and the configured service
connection. Deny every action not listed.

| Identity          | Object scope                       | Allowed S3 permissions                                                                                                                                               |
| ----------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API content       | Content-envelope prefix            | `s3:GetObject`, `s3:GetObjectVersion`                                                                                                                                |
| Worker content    | Content prefix and bucket config   | `s3:GetObject`, `s3:GetObjectVersion`, conditional `s3:PutObject`, `s3:DeleteObject`, `s3:GetBucketPolicy`, `s3:GetBucketVersioning`, `s3:GetLifecycleConfiguration` |
| Content recovery  | Content-envelope prefix            | `s3:ListBucket`, `s3:ListBucketVersions`, `s3:GetObject`, `s3:GetObjectVersion`                                                                                      |
| Release publisher | HTML, asset, and manifest prefixes | `s3:GetObject`, `s3:PutObject`                                                                                                                                       |
| Release cleanup   | HTML, asset, and manifest prefixes | Prefix-scoped `s3:ListBucket`, manifest `s3:GetObject`, eligible-key `s3:DeleteObject`                                                                               |
| Nginx             | No authenticated scope             | None                                                                                                                                                                 |

### Content objects

- The API reads only the exact key and version ID referenced by PostgreSQL. It cannot list, create,
  overwrite, delete, or administer content storage.
- The worker commits a PostgreSQL publication intent before any upload. It creates one random key
  conditionally, never overwrites an existing key, and resolves every ambiguous result with a full
  verified GET. Bucket policy denies content `PutObject` unless the request carries
  `If-None-Match: *`; application discipline alone is insufficient. A mismatch is quarantined and
  alerted rather than repaired in place.
- Routine publication and cleanup use exact PostgreSQL keys. The worker cannot list buckets or
  versions, permanently delete a data version, suspend versioning, change lifecycle policy, or
  administer the bucket. It may read bucket policy, versioning, and lifecycle configuration so
  publication and cleanup can fail closed on drift. Cleanup acts only after PostgreSQL has
  atomically moved the orphan into its deletion outbox.
- Content-bucket versioning is mandatory. Current keys have no age-based expiry. After the eight-day
  readable orphan grace, a cleanup delete marker hides the key while its data version remains
  recoverable for at least eight additional days. Halt cleanup when versioning or lifecycle
  configuration drifts.
- Cleanup checks current-key state before every mutation. A never-uploaded key receives no delete
  marker. An expected current data version receives `DeleteObject` without a version ID; an existing
  current delete marker receives no second delete; and any other current version is quarantined.
- The content-recovery identity exists only for an approved PostgreSQL restore. It can inventory the
  opaque content prefix and read exact versions but cannot write, delete, or administer objects. Run
  it from an ephemeral private workflow. Unknown current data keys receive unowned quarantine
  records and a new eight-day grace; unknown noncurrent versions and delete markers remain read-only
  inventory until their existing lifecycle expires.
- A restored live reference hidden by a marker or superseding version is not safe merely because an
  exact-version GET succeeds. The controlled `recovery_repair` operation uses the normal worker's
  create-only permission to verify and republish those bytes under a fresh key, preserving content
  version and representation digest. It grants no delete-version permission.
- During disaster recovery, revoke old worker writes, prove denial, and wait out the two-minute
  object-request bound before inventory begins. Revoke the recovery identity before application
  workers restart. A PostgreSQL fence in an abandoned cluster cannot stop that cluster's credentials
  from creating Object Storage objects.

The API requests exact versions but still verifies envelope integrity on every cache miss. Exact
version selection keeps a delete marker or unrelated latest version from changing the bytes attached
to a PostgreSQL reference; it is not a substitute for application validation. The complete state,
lease, retry, and deletion protocol is [ADR 0009](decisions/0009-content-object-publication.md).

### Browser release assets

- Allow anonymous `s3:GetObject` only for release HTML and asset object prefixes when
  `yc:private-endpoint-id` matches that service connection and `aws:SecureTransport` is true. Grant
  no anonymous list, write, delete, policy, or configuration operation. Deny unsigned reads of
  browser manifests and every other release-bucket key.
- Limit cleanup deletion to expired release documents and manifests and to asset candidates absent
  from the protected manifest union. The publishing protocol uses conditional writes and rejects an
  existing key with different bytes.
- Serialize publication and cleanup under one release-maintenance lock. Hold it from before the
  publisher checks or uploads assets until after manifest and HTML publication. Cleanup recomputes
  the protected manifest union under the lock immediately before deleting candidates.
- Give Nginx no Object Storage credential. It sends unsigned `GET` and `HEAD` requests through the
  private endpoint.
- Publish end-user `/assets/<content-hash>.<ext>` through the public `reader.mprvr.net` vhost and
  admin assets through the private `reader-admin.mprvr.net` vhost. Disable directory listing and SPA
  fallback on both hosts.
- Route only `/assets/` to release storage and `/images/` to the image cache on `reader.mprvr.net`.
  Return `404` for every other path, including `/api`, `/auth`, and SPA navigations.
- Canonicalize object keys before proxying. Reject traversal, encoded separators, unexpected query
  parameters, and keys outside the configured asset prefix.
- Strip `Cookie`, `Authorization`, and other browser credentials before the storage request. Static
  origins do not set cookies and do not return `Access-Control-Allow-Credentials`.
- Reserve `mprvr.net` for cookieless delivery. No service sets a cookie for that parent domain.
- Return `Access-Control-Allow-Origin: https://reader.priver.org` on asset and image responses from
  `reader.mprvr.net`, and `Access-Control-Allow-Origin: https://admin.reader.priver.org` from
  `reader-admin.mprvr.net`.
- Set explicit content types, `X-Content-Type-Options: nosniff`, and long `public, immutable`
  caching on content-addressed assets. Return a real `404` for a missing key.
- Keep versioned HTML and browser manifests outside the publicly routed asset prefix. Application
  vhosts serve HTML with revalidation rather than immutable caching.
- Do not publish browser source maps. Upload them directly to the configured error-reporting service
  when release diagnostics require them.

Admin assets are reachable only through the same Bastion path as the admin application. They still
contain no credentials, environment secrets, or data that substitutes for server-side authorization.
The API protects every privileged endpoint named by the bundle.

Endpoint-conditioned anonymous reads are network authorization, not workload identity. Any
compromised workload able to use the permitted service connection can read release HTML and assets.
Keep content envelopes in a separate bucket that requires authenticated API or worker access even
through the service connection, and never place secrets in either browser build.

## Image proxy

imgproxy is private behind Nginx. Only Nginx publishes its signed path at
`https://reader.mprvr.net/images/`.

### URL authorization

- The Go API creates every imgproxy URL when it serves an article or list DTO.
- Sign the complete `/images/` path, source URL, content version, preset, width, and format with
  HMAC.
- Store signing key and salt in Yandex Lockbox.
- Configure multiple key/salt pairs during rotation and sign new responses with the current pair.
- Enable imgproxy signature verification in every non-local environment.
- Use preset-only mode; the client cannot choose arbitrary processing options.
- Reject unsigned image routes and never route `/images/` to browser-release Object Storage.

Public source URLs may remain visible in encoded paths. Reject URL user information. Never attach
Reader credentials, cookies, or headers. Reader treats publisher-supplied query strings and path
capabilities as public because it does not support private feeds. Users must not submit feeds whose
images depend on confidential URLs. Signatures prevent changes to the source or processing policy.

Durable content stores placeholders and image manifests, not signed URLs. Retiring an old key does
not require rewriting saved bodies; the next article response receives newly signed paths.

Article and list DTO validators include the signing-key generation. After rotation, conditional
requests receive a fresh representation rather than retaining retired signatures through `304`.

### Source policy

- Allow only public HTTP(S) image sources.
- Reject image URL user information before it enters a manifest or lead-image projection.
- Explicitly disable loopback, link-local, and private source addresses. imgproxy's private-address
  default must be overridden.
- Block metadata destinations at the host firewall.
- Send no browser cookies, authorization headers, or user identity to publishers.
- Strip browser cookies and authorization headers at the cookieless image vhost before cache lookup
  or proxying to imgproxy.
- Verify TLS and bound redirects and download time.
- Cap source files at 10 MiB and source resolution at 40 megapixels.
- Keep animation frames, output dimensions, workers, active clients, and request queue bounded.
- Keep SVG sanitization enabled and rasterize when the selected preset requires it.
- Disable security-option overrides in request URLs.

The visual presets will determine exact responsive widths and animation behavior. Those design
choices do not change the security caps.

### Cache policy

- Emit explicit AVIF and WebP paths instead of varying one URL by `Accept`.
- Include a content-version buster in immutable image paths.
- Cache successful responses in Cloudflare and the Nginx file cache.
- Bound the Nginx cache at 5 GiB with a 30-day inactivity target.
- Use cache locking to prevent duplicate imgproxy work.
- Briefly cache rejected or missing sources.
- Serve stale successful images while imgproxy is failing or updating.
- Use long browser and edge TTLs because a changed content version creates a changed URL.

Cloudflare Free cannot key image variants by `Accept`. Correct behavior requires explicit format
paths. They are also an optimization.

## Identity

Self-hosted Ory Kratos owns browser identity.

- Email one-time code is the bootstrap and recovery method.
- Passkeys are optional at bootstrap and preferred after enrollment.
- Encourage more than one passkey for recovery resilience.
- In beta, let users link Google login only from an authenticated settings flow.
- Never merge identities only because two credential types report the same email address.
- Keep sessions for 30 days and require recent authentication for sensitive changes.
- Use Secure, HttpOnly, appropriately SameSite, host-only cookies. Do not set a parent-domain cookie
  that reaches another Reader origin.
- Protect browser flows and application mutations against CSRF.
- Rate-limit code requests, verification attempts, invitation requests and redemption, and
  account-sensitive operations.

The API validates Kratos sessions directly. It does not mint a second application JWT.

## Invitations and administration

- The public request form accepts exactly one email string of at most 254 UTF-8 bytes and no
  freeform text.
- Validate invitation emails with the same syntax, canonicalization, and comparison rules used by
  identity registration.
- Return the same response for every accepted submission, including when an account, request, or
  invitation already exists.
- Accept at most one pending request per email address and expire it after 30 days.
- Rate-limit requests by network source and an email-derived key without logging the raw address.
- Treat request submission as idempotent. It creates no registration token and grants no access.
- Require an administrator to approve or reject requests. Approval or direct administrator issuance
  is the only way to create an invitation.
- Bind invitation tokens to one email address.
- Sign tokens, make them single-use, and expire them after seven days.
- Store only token verification material required for safe redemption.
- Deliver issued invitations through Postbox without placing tokens in logs or audit metadata.
- Keep the admin SPA at `admin.reader.priver.org`, reachable only through Yandex Bastion.
- Use `reader.priver.org` as the WebAuthn relying-party ID and keep public and admin sessions
  separate with host-only cookies.
- Require an enrolled passkey and application admin role.
- Authorize every admin operation in the Go API.
- Append an audit record for every admin mutation.

Kratos admin APIs, application database credentials, and Lockbox credentials never reach either SPA.

## Secrets

Yandex Lockbox is authoritative for production secrets, including:

- PostgreSQL credentials and CA material
- Kratos cookie, cipher, and webhook secrets
- Postbox SMTP credentials
- imgproxy key and salt
- Cloudflare automation credentials
- API and worker Object Storage credentials when process-scoped workload identities are not
  available
- Browser-release publishing and cleanup credentials when workload identity is not available
- Temporary content-recovery inventory credentials when workload identity is not available
- Sentry and PostHog keys where needed server-side

Do not grant content-object permissions to a VM-wide metadata identity available to every container.
Use separate process-scoped identities for the API and worker, or fetch dedicated least-privilege
credentials from Lockbox at boot and mount each only into its owning container. Nginx has no Object
Storage IAM permission or credential; the private endpoint policy grants its bounded release read
path. Block the Nginx network namespace from cloud metadata and Lockbox. Write runtime secret files
with restrictive permissions and remove them when a blue or green VM is destroyed.

## Telemetry privacy

Operational telemetry may include service, operation, timing, status class, queue depth, and safe
opaque IDs.

Exclude:

- Article HTML, plain text, titles, and search queries
- Feed and article URLs from general logs
- Email addresses, invitation request details, and invitation tokens
- Session cookies, passkey data, SMTP credentials, and signed image source paths
- Object Storage envelopes

The Sentry Free plan receives sanitized frontend failures without article data. Reader adds PostHog
in beta with autocapture, session replay, and automatic URL capture disabled. Allowlisted events may
use an opaque user ID to measure four-week retention but carry no source or article properties.

## Runtime hardening

- Run containers as non-root with read-only filesystems where state is unnecessary.
- Drop Linux capabilities and set CPU, memory, process, and file limits.
- Publish only Nginx and required administration paths.
- Keep imgproxy, Kratos admin APIs, workers, and telemetry collectors on private networks.
- Enforce per-container egress so only intended processes can reach cloud metadata, Lockbox, and
  authenticated Object Storage operations.
- Generate and publish SBOMs.
- Scan application and base images before release.
- Sign GHCR release images with keyless Cosign and verify deployment identity.
- Apply OS security updates and weekly Renovate dependency updates.

## Security completion criteria

Security-sensitive work is complete only when:

1. Every new external input has a documented validation and size boundary.
2. SSRF tests cover DNS, redirects, IPv4, IPv6, and cloud metadata cases.
3. Sanitizer fixtures cover malicious and malformed HTML.
4. Browser tests verify CSP, Trusted Types, links, and image-source behavior.
5. Browser tests verify static-origin CORS, cookie isolation, missing-asset behavior, private admin
   asset reachability, and public denial.
6. Browser tests verify signed image routing on `reader.mprvr.net`, cookie stripping, and separation
   between `/assets/` and `/images/`.
7. Infrastructure tests verify unsigned release HTML and asset reads work only through the
   configured VPC service connection; manifests and every other key deny unsigned reads.
8. Infrastructure tests verify bucket-policy denial of unconditional content writes, conditional
   creation, exact-version read-back, single delete-marker convergence, configuration reads, and
   recovery-window lifecycle behavior through the configured service connection.
9. Infrastructure tests verify API, worker, temporary content-recovery, browser-publication, and
   cleanup permissions remain scoped as documented and that Nginx cannot obtain those identities.
10. Direct origin requests to public application, asset, and image routes fail without Cloudflare
    origin authentication.
11. Logs, Sentry, and analytics samples contain no prohibited fields.
12. The production container scan and `govulncheck` pass, or the change documents the accepted risk.
