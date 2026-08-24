# Deployment

This document specifies the target production and self-hosting operations through invitation beta.

## Environments

Long-lived cloud environment:

- Production in Yandex Cloud `ru-central`

Development and CI use disposable local or workflow services. There is no permanently running cloud
staging environment. During deployment, blue-green release VMs provide a temporary environment with
the production deployment configuration.

## Public and private names

- Public reader: `reader.priver.org`
- Public same-origin API: `reader.priver.org/api`
- Public same-origin Kratos browser flows: `reader.priver.org/auth`
- Cookieless end-user assets and signed images: `reader.mprvr.net`
- Private admin: `admin.reader.priver.org`, reachable only through Yandex Bastion
- Cookieless admin assets: `reader-admin.mprvr.net`, reachable only through Yandex Bastion

The two private admin hostnames use the same private DNS, browser-trusted TLS, Nginx listener, and
Bastion access path. The admin application uses a WebAuthn relying-party ID of `reader.priver.org`,
which is valid for both Reader application origins. Use DNS validation rather than exposing either
admin origin publicly for certificate issuance.

## Yandex Cloud topology

| Component               | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| VPC and security groups | Private service networking and explicit ingress/egress policy |
| VPC service connection  | Private Object Storage endpoint and internal DNS resolution   |
| Network Load Balancer   | Stable origin and blue-green target switching                 |
| Compute VM              | Rootless Podman Compose application color                     |
| Managed PostgreSQL      | Application/River and Kratos databases                        |
| Object Storage          | Content envelopes and immutable browser-release objects       |
| Lockbox                 | Production secrets                                            |
| Postbox                 | Kratos authentication mail and Reader invitation mail         |
| Monitoring and Logging  | OpenTelemetry destinations and infrastructure signals         |
| Bastion                 | Operator access and private admin reachability                |

Cloudflare Free proxies only `reader.priver.org` and `reader.mprvr.net`. It caches immutable image
variants and content-addressed end-user browser assets. `reader-admin.mprvr.net` follows the same
private route as `admin.reader.priver.org`; Cloudflare does not proxy either admin hostname. The
design allows replacing Cloudflare without changing the Yandex origin. Cloudflare connects to the
Yandex Network Load Balancer using strict origin TLS. Nginx requires authenticated Cloudflare origin
pulls or equivalent mTLS and rejects unauthenticated direct-origin traffic. Load-balancer health
checks use a separate narrowly scoped path. Application VMs reach Object Storage through its VPC
service connection rather than the public network.

## VM stack

Each blue or green application VM runs rootless Podman Compose with:

- Nginx with public app, cookieless asset and image, and private admin vhosts
- Go API process
- Go worker process
- Ory Kratos public and admin process configuration
- imgproxy
- OpenTelemetry collector or provider exporter agent

Nginx serves each SPA document by reading the exact versioned HTML object pinned in that VM's
deployment manifest. Browser release files are not copied onto the VM. The public application
document loads immutable assets from `reader.mprvr.net`; the private admin document loads immutable
assets from `reader-admin.mprvr.net`. Nginx reads both release buckets directly through the private
Object Storage service connection without runtime storage credentials.

The private admin application vhost proxies its own `/api` and `/auth` paths so admin browser flows
remain same-origin. It uses host-only cookies, a separate admin login, and the `reader.priver.org`
WebAuthn relying-party ID. The private admin asset vhost reads only the configured admin release
bucket. Nginx rejects both admin `Host` values on the public listener, and the public load balancer
does not target their private listener.

Writable state on the VM is limited to:

- Nginx processed-image cache
- Bounded temporary files
- Runtime secret material fetched from Lockbox

Managed PostgreSQL and Object Storage preserve application data and browser releases when a VM is
replaced. Losing the image cache affects performance but not correctness.

## Resource starting point

Start with the initial VM target of approximately two vCPUs and 4 GiB RAM. Bound API, worker,
imgproxy, and cache concurrency, then scale based on measurements. The managed PostgreSQL cluster
starts with one host and no paid high-availability replica.

Use the Yandex Cloud calculator at provisioning time to determine the exact instance class, disk
size, database host class, and ruble cost. This document omits those values because provider prices
and class names change.

Architecture must pass the scale model in
[`architecture.md`](architecture.md#scale-and-quality-targets) without a data-model redesign.
Production capacity may remain below that target until invitations justify scaling.

## Infrastructure as code

OpenTofu owns:

- VPC, subnets, security groups, service accounts, and the Object Storage service connection
- Private DNS records that resolve Object Storage to the service connection inside the VPC
- Network Load Balancer, listeners, health checks, and target groups
- Compute VMs, disks, and reserved public addresses
- Managed PostgreSQL cluster, databases, roles, and backup policy
- Separate content, end-user release, and admin release Object Storage buckets
- Content-bucket versioning with no current-key expiry, at least eight days of noncurrent-version
  recovery after a delete marker, and one-day incomplete-upload cleanup
- Content-bucket policy that denies PUT without `If-None-Match: *` and permits the worker to read
  but not change versioning and lifecycle configuration
- Service-level restriction of all Object Storage buckets to the Object Storage service connection
- Endpoint-conditioned, TLS-only, read-only policies for release HTML and asset prefixes
- Least-privilege API-content, worker-content, temporary content-recovery, deployment-publisher, and
  release-cleanup identities
- Lockbox containers and IAM bindings, excluding secret values from state where possible
- Monitoring and alert resources
- Public DNS, TLS, and Cloudflare resources for `reader.priver.org` and `reader.mprvr.net`
- Private DNS and browser-trusted TLS for `admin.reader.priver.org` and `reader-admin.mprvr.net`

Use remote, access-controlled state with locking. Treat state as sensitive even when it does not
intentionally contain secret values.

OpenTofu provisions hosts. Cloud-init or a small idempotent boot sequence must install and configure
rootless Podman, retrieve the immutable deployment manifest, and start the selected release.

Protected GitHub Actions workflows control releases. They publish immutable container and browser
artifacts, publish the signed deployment manifest, run reviewed OpenTofu plans and applies, evaluate
automated checks, and update load-balancer membership through managed infrastructure state. CI does
not log in to application VMs over SSH. Reserve Yandex Bastion for approved operator access and
private admin reachability.

Work that requires private VPC access runs on an ephemeral self-hosted Actions runner that OpenTofu
provisions for the release. The runner uses a short-lived registration token and a task-scoped VM
service identity. It retrieves only required secrets from Lockbox and runs signed migration and
verification containers. Browser publication and cleanup use separate least-privilege identities;
never make both permission sets available to one job. Both operate through the Object Storage
service connection and use one non-canceling GitHub Actions concurrency group as the shared
release-maintenance lock. Do not mutate release buckets outside those workflows. Destroy the runner
when the job completes. No CI runner remains on the production network between releases.

## Build and supply chain

GitHub Actions builds release containers and browser applications. It publishes containers to GHCR
and hands browser artifacts to the ephemeral private runner for publication to Object Storage.

Release artifacts:

- Reference immutable image digests, never mutable `latest` tags.
- Address browser assets by a digest of their bytes, independent of the release ID.
- Publish end-user and admin HTML at `/releases/<release-id>/index.html` plus a complete asset
  manifest for each release.
- Reject an upload that would replace an existing asset key with different bytes.
- Include an SBOM and build provenance.
- Use hardened non-root images with minimal runtime contents.
- Pass vulnerability policy before publication.
- Sign images keylessly with Cosign from the protected GitHub workflow.
- Sign the deployment manifest and record browser-artifact digests in its provenance.
- Verify Cosign identity and every container and browser digest before deployment.

Renovate opens grouped weekly dependency updates and immediate security updates for npm, Go, GitHub
Actions, containers, Kratos, imgproxy, Nginx, and OpenTofu providers.

## Blue-green release

Run only one color during normal operation. Create a second color temporarily for a release.

### 1. Prepare

- Merge only after all required checks pass.
- Build, scan, attest, sign, and publish immutable images.
- Build both browser applications with their configured static origins.
- Acquire the release-maintenance lock before checking or uploading browser objects, and hold it
  through browser-manifest and HTML publication.
- On the ephemeral private runner, upload content-addressed assets without overwriting existing keys
  and verify every object.
- Publish a browser manifest for each build that lists all reachable static asset keys.
- Publish versioned HTML only after its browser manifest and all referenced assets are readable.
- Generate a deployment manifest containing exact image digests, HTML object keys, browser-manifest
  digests, and configuration versions.

Do not continue until every artifact in the manifest is reproducible, signed, and deployable without
building on the VM.

### 2. Expand

- On the ephemeral private runner, apply backward-compatible application schema expansion with the
  embedded Goose command.
- Apply required River migrations with its owning tool.
- Apply required Kratos migrations with its owning tool.
- Keep the active blue code compatible with the expanded schema.

Do not continue until blue remains healthy and its integration smoke tests pass on the expanded
schema.

### 3. Create green

- Use OpenTofu to create a fresh green VM and target-group membership.
- Grant the green VM identity only its least-privilege bootstrap access; do not grant it a content
  or browser-release bucket role available to every container.
- Provide content access only to the API and worker through process-scoped identity or a
  per-container secret, and block Nginx from cloud metadata and Lockbox.
- Pull images by digest and verify signatures.
- Configure Nginx with the green release's exact end-user and admin HTML object keys.
- Confirm the Object Storage hostname resolves to the VPC service connection from green.
- Mount no browser-release storage credential in Nginx.
- Start public HTTP services with health and resource limits.
- Keep green schedulers and workers disabled during pre-promotion verification.

Do not continue until every green service is healthy without receiving public traffic.

### 4. Verify green

- Exercise API, Kratos, feed fixture, content and release Object Storage, Postbox test path, and
  imgproxy health.
- Run critical browser smoke flows against a protected green route.
- Verify the public asset and image routes through Cloudflare, the private admin asset route through
  Bastion, dynamic imports, fonts, cache headers, CORS, and missing-asset `404` responses.
- Verify unsigned release HTML and asset reads succeed through the VPC service connection and fail
  from the public network or another service connection. Verify manifests and other keys deny
  unsigned reads.
- Verify authenticated API, worker, publisher, and cleanup operations succeed only through the
  configured service connection and only within each identity's allowed actions and prefixes.
- Verify direct Network Load Balancer requests to public app, asset, and image routes fail without
  Cloudflare origin authentication.
- Open the current blue document, switch the protected route to green, and confirm that blue can
  still load a previously untouched lazy chunk.
- Confirm telemetry, logs, and alerts identify the green release.

Promote only after automated checks pass and an operator can inspect green without database repair.

### 5. Promote

- Require explicit operator approval.
- Stop blue scheduling, wait for blue's running River jobs to complete or return safely to the
  queue, and keep its workers disabled.
- Confirm green understands every queued job payload version, then start green scheduling and
  workers.
- Add green to serving targets and remove or drain blue through the Network Load Balancer.
- Monitor errors, latency, queue lag, login, feed refresh, and image responses.

Promotion succeeds when green serves normal traffic within SLO and no release alarm remains
unexplained.

### 6. Observe and contract

- Keep blue HTTP services intact for 24 hours as an application rollback target; keep blue workers
  stopped.
- Roll traffic back only while every persisted and browser contract remains compatible.
- For rollback, stop and drain green workers before restarting compatible blue workers.
- Destroy blue after the observation window.
- Keep blue's browser release manifest and referenced assets for the 45-day stale-document window.
- Remove obsolete schema in a later release after no supported application version uses it.

The release ends with one active color, revoked old secrets and access, and a tracked contract
change when required.

## Migration policy

Production uses expand-contract sequencing for every persisted or independently deployed contract,
including database schema, River job payloads, content envelopes, generated image placeholders,
Kratos configuration, OpenAPI clients, and SPA/API overlap.

Database sequencing:

1. Add new nullable structures or dual-write capability.
2. Deploy code that can operate with both old and new representations.
3. Backfill through bounded resumable jobs.
4. Switch reads after verification.
5. Stop old writes in a later release.
6. Remove obsolete schema only after rollback no longer needs it.

Migration commands run as explicit pre-deploy jobs, not concurrently from every application process.
Use the owning migration tool for application, River, and Kratos schemas.

During the 24-hour rollback window, new writers produce only representations that blue readers can
consume, or dual-write both representations. Contract cleanup waits until the rollback window and
all old jobs have expired or completed.

Browser-facing API and Kratos changes remain compatible with browser releases retained during the
45-day stale-document window. An incompatible change ships only after old manifests expire, or the
old client detects its unsupported release before the request and requires a full reload. Static
asset retention alone is not a substitute for contract compatibility.

## Secrets

Yandex Lockbox is authoritative for production secrets. GitHub Actions may hold only the credentials
needed to authenticate deployment automation, preferably through short-lived federation.

At boot or deploy:

1. Authenticate with the VM service account.
2. Fetch only secrets required by that color.
3. Materialize rootless-Podman-readable files with restrictive permissions.
4. Keep secrets out of image layers, command arguments, logs, and OpenTofu plans.
5. Remove runtime files and revoke access when destroying the color.

Rotation must support overlapping Kratos and imgproxy keys where their protocols allow it.

## Backups and recovery

Recovery targets:

- Daily recovery point objective
- Eight-hour recovery time objective
- No high-availability database replica during alpha

Managed PostgreSQL:

- Keep automatic daily backups enabled.
- Keep point-in-time recovery enabled.
- Retain at least the provider default seven-day window.
- Take a manual backup before high-risk storage migrations.

Object Storage:

- Enable versioning for content objects.
- Never expire a current content key by age. PostgreSQL retention and saved-reference rules are the
  only authority that may make it an orphan.
- Keep staged, superseded, and retention-removed objects directly readable for eight days from their
  PostgreSQL `orphaned_at` time before the worker creates a delete marker.
- Keep each noncurrent data version for at least eight additional days after its delete marker. Keep
  the marker while that data version remains recoverable, and abort incomplete multipart uploads
  after one day as defense in depth.
- Treat eight days as the minimum derived from the seven-day PostgreSQL point-in-time recovery
  horizon, eight-hour recovery target, and margin. Increase both object windows before increasing a
  database recovery target.
- Halt content publication or cleanup and alert if create-only PUT enforcement is absent, versioning
  is suspended, current-key expiry appears, or the noncurrent-version window becomes shorter than
  eight days.
- Treat browser builds as reproducible release artifacts rather than user data backups.
- Retain superseded browser manifests for 45 days and always retain active and rollback manifests.
- Garbage-collect an asset only when no retained manifest references it and its safety delay has
  expired. Do not apply an age-only deletion rule to content-addressed assets.
- Run garbage collection under the release-maintenance lock and recompute the retained-manifest
  union immediately before deleting candidates.

For recovery, stop publication and cleanup, revoke the old workers' Object Storage writes, prove
that writes are denied, and wait two minutes for bounded in-flight requests before restoring
PostgreSQL to a new cluster. Keep workers disabled while a disposable application color verifies
every current reference by exact object key, version ID, compressed digest, and envelope integrity.
Use the temporary content-recovery identity to inventory keys and versions forgotten by the selected
restore point. Import unknown current data keys as unowned quarantine records with a fresh eight-day
grace; retain unknown noncurrent versions and markers as read-only inventory until their existing
lifecycle expires. For every restored live reference whose exact version is not storage-current, use
a controlled `recovery_repair` operation to verify and publish the same envelope at a fresh key,
preserve its content version and representation digest, and switch the reference atomically. Revoke
the inventory identity before normal workers start, verify every repaired reference, saved bodies,
and Kratos identity mapping, then promote traffic. Never run destructive reconciliation against a
live production bucket while its old database remains authoritative. Run and record a complete drill
before invitation beta and after material storage changes.

## Observability

Applications emit portable OpenTelemetry signals. The alpha backend is Yandex Monitoring and
Logging.

Required signals:

- HTTP request count, latency, and status class
- Feed due lag, fetch duration, result class, and publisher throttling
- River queue depth, age, retries, and failures
- Content publication counts by state, oldest expired lease, orphan age, and deletion-outbox age
- PostgreSQL saturation, storage, connections, and slow queries
- Object Storage latency and error rate
- Public cookieless-origin latency, status, route class, and Cloudflare and Nginx cache result
- End-user and admin asset release IDs and missing-object rates
- Private admin asset-origin latency and status through the Bastion path
- Object Storage service-connection latency and error rate
- Kratos login, code delivery, and flow errors without identity data
- Invitation request, approval, and delivery outcomes without email addresses
- imgproxy queue, processing duration, rejection class, and Nginx cache status
- Deployment color, release digest, and migration version

The Sentry Free plan receives sanitized frontend failures. Telegram is the only urgent alert
notification destination through beta. Reader adds PostHog Cloud in beta for allowlisted,
content-free product events.

## Alerting

Page or notify on conditions requiring operator action:

- Public origin or critical health check unavailable
- The public cookieless origin or private admin asset origin unavailable, an elevated asset `404`
  rate, or an image-response failure surge
- Eligible high-frequency feed freshness target violated
- River oldest-job age growing persistently
- Database or Object Storage error surge
- PostgreSQL storage, connections, or CPU near capacity
- Kratos authentication or Reader invitation-delivery failure surge
- imgproxy worker or queue saturation
- Backup failure
- Expired content-publication lease, stuck deletion outbox, missing referenced object, integrity
  mismatch, or content-bucket versioning and lifecycle drift
- Monthly spend approaching the RUB 10,000 review ceiling

Alerts include a runbook link and release color. They exclude article content, feed URLs, email
addresses, and credentials.

## Cost control

- Start with one small VM and one single-host managed PostgreSQL cluster.
- Keep green transient and destroy blue after 24 hours.
- Keep only production as a long-lived cloud environment.
- Bound subscriptions, retention, image cache, workers, and queues.
- Monitor Object Storage requests and database storage separately.
- Track retained browser-release bytes and requests by end-user and admin bucket.
- Track Object Storage service-connection hours, traffic, and errors.
- Pause invitations or review scaling near RUB 10,000 monthly spend.

Reaching the ceiling triggers a decision. It does not guarantee that the target architecture scale
fits below the ceiling.

## Operational completion criteria

An infrastructure or release change is complete when:

1. OpenTofu plan contains only intended changes and no exposed secret values.
2. Green passes health, critical smoke, and telemetry checks.
3. Blue remains a tested rollback target for the documented window.
4. Migration compatibility is demonstrated for both colors.
5. Backup and restore assumptions remain valid.
6. Cost and capacity impact is measured or bounded.
7. A document from the previous release can load a previously untouched lazy chunk after promotion.
8. Release HTML and assets reject unsigned reads outside the configured Object Storage service
   connection, and manifests reject unsigned reads everywhere.
9. Authenticated content, publication, cleanup, and temporary recovery-inventory operations reject
   the public endpoint and other service connections; the recovery identity is absent outside an
   approved restore.
10. Content PUTs require their create-only precondition, current keys have no age expiry, and the
    configured delete-marker and noncurrent-version behavior preserves both eight-day recovery
    windows.
11. Deployment and decision documentation matches the released behavior.
