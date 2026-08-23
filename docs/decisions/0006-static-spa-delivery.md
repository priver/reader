# 0006: Store browser releases outside application VMs

Status: Accepted

## Context

The end-user and admin applications use route-level code splitting. A browser can keep an old
document open across a deployment and request a lazy chunk later. If each VM owns only its current
browser build, destroying blue or replacing files during a release makes that chunk unavailable.

Putting every asset below a release-specific URL would preserve old builds, but it would also change
the URL of an unchanged chunk on every release and waste browser and edge cache entries.

## Decision

Store browser releases in private S3-compatible Object Storage and proxy reads through Nginx on the
application VM. In Yandex Cloud, Nginx accesses the release buckets directly through a VPC Object
Storage service connection with private DNS. Restrict both buckets at the service level to that
connection so their public endpoints cannot serve objects.

Bucket policies allow unsigned, TLS-protected `GET` and `HEAD` access only when
`yc:private-endpoint-id` matches the configured service connection and the object is release HTML or
a browser asset. Nginx holds no Object Storage credential. Publishing and cleanup remain
authenticated operations executed from inside the VPC.

The cleanup identity may list only the release prefixes, read retained browser manifests, and delete
only expired release documents, manifests, and unreferenced asset candidates. Browser manifests and
all non-release keys deny unsigned reads.

Serialize publication and cleanup with one release-maintenance lock. The publisher holds the lock
from before it checks or uploads assets until after it publishes the browser manifest and HTML.
Cleanup acquires the same lock and recomputes the protected manifest union immediately before
deleting candidates. In the hosted deployment, a non-canceling GitHub Actions concurrency group
provides the lock for both workflows; do not mutate release buckets out of band.

The maintained Compose deployment uses the equivalent network boundary: release storage is exposed
only on the private Compose network, where just the release HTML and asset prefixes grant read-only
access. Browser manifests remain authenticated. An external S3-compatible provider without
private-network policy requires an authenticated object gateway.

Keep the application documents on their application origins:

- End-user application: `https://reader.priver.org`
- Private admin application: `https://admin.reader.priver.org`

Serve their cookieless build assets from separate origins:

- Public end-user assets: `https://reader.mprvr.net`, proxied by Cloudflare
- Private admin assets: `https://reader-admin.mprvr.net`, reached through the same Bastion path as
  `https://admin.reader.priver.org` and not proxied by Cloudflare

This decision owns only the `/assets/` route on `reader.mprvr.net`. The separate `/images/` route
serves signed imgproxy responses under [ADR 0004](0004-image-delivery.md) and never reads browser
release storage.

Each deployment manifest pins exact `/releases/<release-id>/index.html` objects for its end-user and
admin builds. These are storage keys, not browser-visible application URLs. Both builds publish
assets as immutable `/assets/<content-hash>.<ext>` keys that do not contain the release ID. Upload
and verify all asset objects, then publish the browser manifest, before publishing HTML that
references them. Never overwrite an asset key with different bytes.

Each browser release manifest lists the asset keys reachable from its HTML and dynamic imports.
Retain superseded release manifests for 45 days and protect every release referenced by an active or
rollback deployment regardless of age. Garbage collection computes the union of those manifests and
deletes only unreferenced assets after a safety delay. Do not use an age-only lifecycle rule for
asset objects.

Keep frontend/API and browser-facing authentication contracts compatible for the same 45-day stale
document window. A client older than that window may be required to reload before making an
incompatible request.

## Consequences

- Destroying a blue VM does not remove chunks needed by an old tab.
- Unchanged chunks retain the same URL and browser-cache entry across releases.
- Nginx and the Object Storage service connection become part of browser-release availability.
- Release HTML and asset reads use network authorization. Any compromised workload able to use the
  allowed service connection can read those objects, which therefore contain no secrets.
- The hosted deployment needs no runtime release-storage secret, but external self-hosted S3
  services may still need an authenticated gateway.
- Admin JavaScript and CSS are private to the Bastion route. They still contain no secrets, and the
  API enforces every admin authorization decision.
- Release cleanup requires reference-aware garbage collection rather than a simple bucket-age rule.
- The two static origins need independent DNS, TLS, access, CSP, CORS, cache, and monitoring
  configuration. Only the end-user origin uses Cloudflare.
