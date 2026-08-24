# Data model

This document defines the conceptual target model and invariants through invitation beta. It is not
a SQL schema. The first migrations and fixture corpus will determine exact columns, primary-key
representations, and indexes while preserving the versioned entry and content contracts below.

## Storage boundaries

| Store                           | Owns                                                                                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application PostgreSQL database | Users, invitation requests, invitations, folders, feeds, subscriptions, entries, sparse user state, OPML import runs, bulk-read undo context, jobs, fetch history, audit records, content publication intents, references, deletion outbox, and recovery quarantine |
| Kratos PostgreSQL database      | Identities, credentials, sessions, verification, recovery, social login                                                                                                                                                                                             |
| Private content Object Storage  | Immutable versioned compressed envelopes, delete markers, and recoverable noncurrent versions                                                                                                                                                                       |
| Private browser-release buckets | Versioned HTML, release manifests, and content-addressed browser assets                                                                                                                                                                                             |
| Nginx disk cache                | Rebuildable processed image responses; never authoritative data                                                                                                                                                                                                     |

Application and River tables share one database and transaction boundary. Kratos uses a distinct
database and role in the same initial managed cluster. Application code does not query Kratos tables
directly. PostgreSQL alone decides whether an Entry and content-object reference are current or safe
to delete. Object Storage retains opaque bytes and version history but knows nothing about Entries,
saves, or retention eligibility.

Browser releases are deployment artifacts, not application records or user data. Their 45-day
stale-document retention and reference-aware cleanup policy live in
[`deployment.md`](deployment.md#backups-and-recovery) and
[`0006-static-spa-delivery.md`](decisions/0006-static-spa-delivery.md).

## Ownership model

Public feed data is global. User choices and state are private.

```mermaid
erDiagram
  KRATOS_IDENTITY ||--|| USER : maps_to
  USER ||--o{ INVITATION : creates
  INVITATION_REQUEST o|--o| INVITATION : approved_as
  USER ||--o{ FOLDER : owns
  USER ||--o{ SUBSCRIPTION : owns
  FOLDER ||--o{ SUBSCRIPTION : contains
  FEED ||--o{ SUBSCRIPTION : followed_by
  FEED ||--o{ ENTRY : publishes
  ENTRY ||--o{ CONTENT_OBJECT : owns_attempts
  ENTRY o|--o| CONTENT_OBJECT : references_current
  USER ||--o{ ENTRY_STATE : records
  ENTRY ||--o{ ENTRY_STATE : receives
  USER ||--o{ ADMIN_AUDIT : performs
  FEED ||--o{ FETCH_ATTEMPT : records
```

The diagram is conceptual. `KRATOS_IDENTITY` is an external identity reference, not an application
table join.

## Entities

### User

Each application profile maps to one immutable Kratos identity ID.

Owns:

- Preferences and theme
- Folders and subscriptions
- Sparse article state
- Subscription export and deletion lifecycle
- Optional application roles

Email addresses and credentials remain Kratos-owned. Copy identity traits into application data only
when a product requirement needs them.

### Invitation request

An unauthenticated visitor submits one email address through the public form. The request grants no
access and contains no registration token or reusable credential.

Invariants:

- At most one pending request exists for an email address.
- A pending request expires 30 days after submission.
- Only an administrator may approve or reject a request.
- Approval creates a separate invitation; rejection and expiry cannot be redeemed.
- The public response does not reveal whether the email belongs to an account, request, or existing
  invitation.

The record contains the email address, request and expiry times, resolution status, and the optional
resulting invitation reference. Email comparison must use the same rules as identity registration.

### Invitation

An administrator creates a single-use registration invitation directly or by approving an invitation
request for one email address.

Invariants:

- Expires seven days after issuance.
- Stores no reusable login credential.
- Cannot be redeemed for a different email address.
- Records creator, optional source request, redemption, expiry, and revocation for audit.

### Folder

A user-owned named group. Each subscription belongs to at most one folder. Folder names are unique
per user after trimming leading and trailing Unicode whitespace, collapsing each internal Unicode
whitespace run to one ASCII space, and normalizing to NFC. A normalized name must be nonempty and at
most 255 UTF-8 bytes. Comparison remains case-sensitive.

#### OPML path flattening

Reader walks `<outline>` start elements below `<body>` in depth-first document order. An outline
with a nonempty `xmlUrl` after ASCII-whitespace trimming is a feed occurrence, even when its URL
later fails validation. Its own `text` or `title` never contributes a folder component. Other
ancestor outlines contribute the first nonempty normalized value of `text` then `title`; empty
components are skipped. Unnamed wrapper outlines therefore do not create folders.

Reader joins components with the three-character separator space, slash, space. A feed with no named
ancestor remains unfiled. Equal normalized component arrays are one source path. Paths that become
equal through documented whitespace or Unicode normalization intentionally coalesce.

Distinct component arrays can flatten to the same base, such as nested `Tech` then `Security` and
one literal `Tech / Security` component. Process new Feed groups by winning occurrence. For each
path, start with its base; if another path admitted by this run already claimed that name, append
` (2)` to the original base, then try ` (3)` and higher until the name is unclaimed. Thus a literal
`Tech / Security (2)` that follows a generated `Tech / Security (2)` receives
`Tech / Security (2) (2)`. An existing folder with the selected normalized name is reused rather
than causing another suffix.

Names are never truncated. A selected name over 255 UTF-8 bytes is an item error and does not
consume a subscription slot or claim the name; processing continues with the next Feed group. Name
claims are immutable for retries of one import run. A later run recomputes names for subscriptions
it can newly add against its own source order and current folders; Reader does not retain OPML
source-path identity after a run. Existing subscriptions still never move.

#### OPML import run

An accepted upload produces an immutable import run and ordered candidate plan. The parser accepts
one uncompressed XML document with one unqualified `<opml>` root and exactly one direct `<body>`,
rejects DTDs, custom entity declarations, and XInclude, and applies the limits in
[`security.md`](security.md#opml-import). Malformed XML, an invalid root or body, or any
document-level limit violation rejects the whole upload before folder or subscription changes.
Unknown elements and attributes are ignored within those limits.

A syntactically valid document can complete partially. Each feed occurrence passes through the same
4,096-byte URL canonicalizer, safe HTTP client, redirect policy, and feed parser as direct addition.
Invalid or blocked URLs, authoritative DNS absence, redirect-policy failures, TLS certificate
failures, response-size limit failures, HTTP `4xx` other than `408`, `425`, and `429`, and a
successful response that is not a valid RSS or Atom feed are permanent item errors. Temporary DNS
and transport failures, timeouts, HTTP `408`, `425`, `429`, and `5xx` receive exponential backoff
and at most five total attempts.

No attempt may start unless the PostgreSQL clock is strictly before the run's acceptance time plus
24 hours. A valid `Retry-After` selects the later of publisher delay and normal backoff; an invalid
value is ignored. If the selected next-attempt time is at or after the deadline, the item becomes
terminal at the deadline. An attempt started before the deadline may finish within its normal
request timeout. One user may have only one resolving or finalizing import run, and a new upload
cannot replace it.

Finalization waits until each candidate has resolved or reached a terminal outcome, then applies the
user-visible result in one PostgreSQL transaction:

1. Collapse successfully resolved occurrences by final Feed identity, including permanent aliases
   and Feed merges. Raw URL equality is not the deduplication boundary.
2. Select the earliest successfully resolved occurrence in document order for each Feed. Its
   flattened path wins even when it is unfiled; job completion order cannot affect placement.
3. Report `already_subscribed` and leave the existing folder placement, initial watermark, and
   private Entry state unchanged.
4. Process remaining Feed groups by winning occurrence. While a slot remains, derive and validate
   its folder name against names claimed by earlier admitted groups. A `folder_name` error neither
   claims the name nor consumes a slot, so the next valid group can use that slot. Admit each valid
   group until the user's 500-subscription limit is reached; report later groups as
   `subscription_limit` without deriving or creating a folder.
5. Create or reuse only folders referenced by admitted groups. Set each new subscription's initial
   watermark to the latest Entry observation available at finalization, so existing entries begin
   read and later observations begin unread.

The result counts source occurrences separately as permanently failed, retry-exhausted, resolved
winner, or resolved duplicate. It also counts resolved Feed groups as imported,
`already_subscribed`, `folder_name`, or `subscription_limit`. Resolved duplicates and
`already_subscribed` are non-error outcomes. Each failed occurrence gets an error anchored to its
source ordinal; each Feed-level `folder_name` or `subscription_limit` error is anchored to the
winning occurrence. Return at most the first 100 error details in that order while retaining
complete aggregate counts.

The import run ID fences worker retries. Repeating resolution or an ambiguous finalization commit
reads the persisted run and converges on the same result; it cannot consume another subscription
slot or append a suffix to a folder. Uploading the same file as a new run is duplicate-safe, not a
no-op guarantee: existing subscriptions and folders are not duplicated, but a previously failed item
can succeed and capacity or current folders can differ in the new bounded attempt window.

### Feed

A globally shared public RSS or Atom source.

Owns:

- Canonical fetch URL, permanent endpoint aliases, and public site URL
- Display metadata
- HTTP validators
- Publication history
- Adaptive refresh schedule
- Health and failure state

The model stores no separate feed credentials or custom request headers through beta. The complete
canonical URL, including its path and query, is public endpoint identity. Signed, tokenized, and
otherwise confidential URLs are unsupported.

Endpoint invariants:

- Each normalized canonical URL or permanent alias has one global Feed owner.
- A leading chain of HTTP `301` and `308` responses may replace the canonical fetch URL. Preserve
  prior permanent endpoints as aliases so later submissions resolve to the same Feed.
- Temporary redirect targets never become aliases.
- If a permanent redirect reaches another Feed's endpoint, the target Feed survives an idempotent
  merge. Preserve source-only subscriptions and folder placement. When one user has both
  subscriptions, retain the target subscription.
- Do not merge Feeds by response content, parsed entries, title, public site URL, Atom `rel=self`,
  DNS alias, or temporary redirect target.

Entry collision behavior during a Feed merge follows the feed-scoped identity contract below. The
URL contract lives in [`0007-feed-url-policy.md`](decisions/0007-feed-url-policy.md).

### Subscription

A private user-to-feed relationship.

Owns:

- Folder placement
- Subscription creation time
- Initial read boundary
- Bulk read watermark

The hosted service accepts at most 500 active subscriptions per user.

### Entry

A feed-scoped, globally shared publication record.

Owns:

- Feed relationship
- Stable feed-scoped identity
- Publisher URL
- Title, author, publication time, and update time
- Feed-local observation position
- Validated lead-image source for list-thumbnail projection
- Current content-object reference
- Content version
- Current normalized-representation digest

Publisher updates replace the current ordinary and saved representation. Reader does not expose
article revision history through beta.

#### Identity

Each Entry has an immutable versioned identity key unique within its Feed. Identity v1 uses the
first available source:

1. Opaque, case-sensitive RSS GUID or Atom ID after removal of surrounding XML whitespace
2. Canonical publisher link
3. Normalized title plus valid publication time
4. A source fingerprint over normalized title, authors, valid publication time, and selected
   feed-provided body

The stored form is `v1:<tier>:sha256:<lowercase-hex>`.
[ADR 0008](decisions/0008-entry-content-contracts.md) defines exact normalization, hash framing, and
fallback inputs. Reader rejects an item with no usable identity input. It never uses fetch time,
item position, or a random value.

A repeated key in one response is one candidate Entry. Reader chooses the greatest valid update
time, then greatest valid publication time, then the lexicographically smallest normalized
representation digest. Document order cannot change the winner. Different publisher IDs remain
different entries even when their links match; changing a publisher ID creates a new Entry.

When a permanent redirect merges Feeds, non-colliding Entries move to the target Feed. For an
identity collision, the target Entry ID survives and the same duplicate rule selects its current
representation. Retarget private Entry state and saved references. If one user has both state rows,
saved is true when either was saved, resolved visible unread wins over visible read, reading
progress keeps the furthest value, and last-opened time keeps the latest value. Read resolution
includes both watermarks and explicit markers, so an implied unread value still wins an implied or
explicit read value.

A Feed merge first locks source and target Feeds in ascending ID order and commits a merge fence.
While fenced, new Entry publication, import finalization, and bulk mark-read snapshots touching
either Feed defer. The merge can then wait without holding row locks until every affected undo
context is undone, superseded, or expired; because no new context can start, this wait is at most 30
seconds from the fence. The final merge transaction locks both Feeds in ascending ID order before
locking affected Entries in ascending ID order and fences their refreshes and publication intents.

That transaction preserves each affected user's visible read state for Entries from every Feed they
followed before the merge; Entries gained from a Feed they did not follow begin read. It advances
the surviving subscription watermark through every Entry current at the merge and materializes
unread exceptions only where the pre-merge state was unread. For an identity collision where the
user had both subscriptions, the visible-unread-wins rule above chooses the pre-merge state.

Target Entries retain their observation positions. Source-only Entries receive consecutive target
positions after the prior target maximum, ordered by source position and then Entry ID; identity
collisions keep the target Entry and position. The target Feed counter advances through those
assignments in the merge transaction, so Entries published after the merge compare newer than the
reconciled watermarks.

#### Content version

Content version is a positive monotonic 64-bit integer. A new Entry starts at 1. For the same
identity, a changed durable representation increments it by exactly one; an unchanged normalized
representation keeps the current version and object. The digest covers publisher URL, normalized
title and authors, valid dates, body source kind, sanitized HTML, plain text, image manifest, and
lead-image projection. It excludes fetch and XML formatting, unknown fields, storage metadata, and
compression bytes.

Writers stop at the I-JSON exact-integer limit of 9,007,199,254,740,991 even though PostgreSQL uses
a signed 64-bit column.

Failed object publication does not make a proposed version current. A version proposed by an intent
is assigned only when PostgreSQL publishes it; abandoning the intent does not consume that number.
The next successful publisher change is therefore exactly current version plus one. Assigned
versions never decrement or repeat, including when a publisher restores earlier content. A pure
storage-schema or compression migration may preserve the version when browser output and lead image
remain identical. Any migration that changes durable publisher output increments it.

### Content object

PostgreSQL metadata for an immutable envelope in private Object Storage. One object belongs to one
Entry and one publication intent; Reader does not deduplicate objects between Entries. Its opaque
key is `content/objects/<random-object-id>.json.gz`. A retry of one intent reuses that key, while a
different intent always receives a new key. Keys never contain feed, Entry, user, or
proposed-version identity and are never reused after deletion.

Envelope v1 is RFC 8785 canonical I-JSON compressed with deterministic gzip level 6. The gzip header
has zero modification time, OS 255, and no name, comment, or extra fields. Objects use media type
`application/vnd.reader.content+json` and content encoding `gzip`.

Every field is required, including empty arrays and null values:

| Field                | Contract                                                                    |
| -------------------- | --------------------------------------------------------------------------- |
| `schema_version`     | Positive integer selecting the strict decoder; v1 is `1`                    |
| `content_version`    | Matches the current Entry content version                                   |
| `normalizer_version` | Version of deterministic HTML and metadata normalization                    |
| `sanitizer_version`  | Version of the final Bluemonday policy                                      |
| `body.source`        | `content`, `summary`, or `empty`                                            |
| `body.html`          | Final sanitized HTML fragment with typed app-owned placeholders             |
| `body.text`          | Plain text derived from that fragment and image alt text                    |
| `images`             | Ordered `{id, source_url, alt}` manifest items                              |
| `lead_image_id`      | Manifest ID copied into the list projection, or null                        |
| `integrity`          | `sha256` and lowercase digest of canonical envelope data without this field |

Each accepted body image becomes `<reader-image data-image-id="image-N"></reader-image>` in document
order. Publisher-supplied versions of that element or attribute are removed before placeholders are
created. Each placeholder maps to exactly one manifest item. A lead-only item may be the sole
unreferenced manifest record. Envelope v1 stores no image dimensions. Durable content stores no
signed imgproxy URLs.

The API bounds decompression, rejects duplicate JSON properties, dispatches by schema version,
verifies the integrity digest, and validates placeholder IDs, lead-image references, and public
image URLs before rendering. Unknown or corrupt content fails closed.

After successful processing, the worker discards source feed XML and unsanitized body HTML. Reader
does not fetch linked article pages. The API generates signed imgproxy URLs from the image manifest
at response time; they are not durable body data.

#### Publication state

Before any Object Storage request, PostgreSQL commits a Content object intent containing:

- Owning Entry and immutable key
- Base current-object ID, content version, and representation digest
- Publisher-update, storage-rewrite, or recovery-repair operation kind; target format; proposed
  version; candidate digest; and pending typed Entry metadata
- Expected compressed length and SHA-256, envelope integrity digest, and format versions
- Exact Object Storage version ID once an upload is found
- State and transition times
- Monotonic publication fence, 15-minute lease, orphan time, and cleanup deadline

Pending typed metadata is sufficient to combine the uploaded body with its title, authors, dates,
publisher URL, and projections after a crash. PostgreSQL does not stage another copy of body HTML or
envelope bytes. An internal Entry shell may reserve a new feed-scoped identity, but every product
query requires a current-object reference, so the shell is not visible.

Content object state moves from `staged` to `verified` to `current` to `orphaned`. A staged or
verified attempt may instead become orphaned. At most one staged or verified intent exists per
Entry. Both the Content object's owning-Entry foreign key and `Entry.current_content_object_id` are
restrictive and never cascade. The Entry shell remains until all owned Content object rows move to
the deletion outbox. Current Entry metadata, content version, representation digest, and object
reference always change in one PostgreSQL transaction.

#### Publication protocol

1. The worker creates deterministic envelope bytes and their expected digests before opening the
   staging transaction.
2. It locks the Entry and returns a no-op for a publisher candidate with the current digest. An
   explicit storage rewrite continues when its target format or compressed digest differs. The
   `recovery_repair` operation continues when a restored exact version is not storage-current, even
   when format and bytes are unchanged. The worker recovers an intent only when operation kind,
   candidate, target format, and compressed digest all match, or waits for a different intent's live
   lease. After a lease expires, takeover increments its fence; only the current fence may change
   state.
3. The worker records and commits the intent before conditionally creating its random object key. A
   fresh read-only policy check must pass, and bucket policy denies PUT without `If-None-Match: *`.
   An unknown transaction result is resolved by the Entry, base, operation, target, candidate
   digest, and compressed digest before upload. No PostgreSQL transaction stays open during a
   storage request.
4. The lease holder performs a full GET after PUT, including when the PUT result was ambiguous or
   the key already existed. It verifies the exact version ID, compressed length and SHA-256, strict
   envelope decoder and internal integrity checks, proposed content version, and representation
   digest reconstructed with pending metadata. HEAD and ETag checks cannot mark an object verified.
5. For a new Entry, the publication transaction locks the Feed before the Entry and assigns the next
   observation position. It then checks the intent fence, persisted feed-refresh generation, and
   Entry base object, version, and digest. It atomically installs the proposed Entry data and marks
   the new object current. A former current object becomes orphaned in the same transaction. A
   `recovery_repair` instead moves its restored noncurrent base metadata to recovery quarantine
   under the existing lifecycle deadline.

The final PostgreSQL commit is the only publication point. A retry after upload repeats
verification; a retry after an ambiguous commit reads the Entry and treats a matching object and
digest as success. A changed base, stale feed generation, missing Entry, unexpected object, or
failed verification can only orphan the intent. It cannot expose or overwrite its bytes.
Storage-only backfills and recovery repairs use explicit operation kinds and follow the same
base-object compare-and-swap.

Publication leases last 15 minutes, heartbeat once per minute, and fence every state transition. An
Object Storage request is bounded to two minutes and cannot start without that much lease time
remaining. A stale holder may finish writing its intent's unique key, but it cannot publish after a
takeover.

#### Orphan cleanup

Abandonment, replacement, and retention set `orphaned_at` and `gc_not_before` using the PostgreSQL
clock. The object remains directly readable for eight days. After that grace, cleanup may claim it
only if no current Entry or explicit migration/recovery pin references it, no lease is live, the
lease plus the two-minute request bound has elapsed, and content-bucket versioning and lifecycle
policy pass a fresh read-only health check. Every supported pin uses a restrictive foreign key.

The claim transaction deletes the eligible Content object record into a deletion outbox. The
restrictive current-reference foreign key makes this atomic with respect to concurrent publication:
a committed reference prevents the claim, while a committed claim makes a later reference fail. The
outbox keeps the key, optional exact data-version ID, digests, terminal disposition, delete result,
and recovery expiry.

After waiting out any last request bound, cleanup checks the current key. Absence without a current
delete marker records `never_uploaded` and sends no delete. If the expected version is current,
cleanup persists the request start and sends `DeleteObject` without a version ID. If a delete marker
is already current, it records that marker and sends no second delete; a different current data
version is quarantined and alerted. Failed and ambiguous requests return to the current-key check,
so cleanup sends another delete only when the expected data version is still current. Exact-version
read-back confirms that the original bytes remain recoverable. The delete-attempt start plus eight
days is the conservative recovery deadline; a known failed attempt retried later extends it.

Current keys have no age-based Object Storage expiry. Lifecycle policy keeps the noncurrent data
version for at least eight days after its delete marker and keeps the marker while that data version
is recoverable. Routine workers use exact PostgreSQL keys and never list the bucket. After a
PostgreSQL point-in-time restore, a separate recovery-quarantine record can hold an unknown key and
version without an owning Entry or pending metadata. It can never be published. Unknown current data
keys receive a new eight-day grace; unknown noncurrent versions and markers remain inventory records
until their existing lifecycle expires.

A restored Entry cannot continue to reference a data version that is already noncurrent in Object
Storage because its original lifecycle may purge it. Before promotion, recovery rewrites every such
verified envelope to a fresh random key, preserves its content version and representation digest,
and atomically switches the Entry through a distinct `recovery_repair` intent. The old Content
object metadata moves to recovery quarantine with its existing lifecycle instead of receiving a new
grace. Every repaired reference must be storage-current. The complete rules live in
[`0009-content-object-publication.md`](decisions/0009-content-object-publication.md).

Identity and envelope versions never change meaning. Envelope writers emit only the current version;
rolling deployments add old-and-new readers before new writes begin. Backfills verify the old
object, write and verify a new object, and switch the reference through the normal publication
protocol in [ADR 0009](decisions/0009-content-object-publication.md). They never mutate an object in
place. Existing identity keys remain immutable; a future identity version requires dual lookup and
explicit aliases before writers switch.

Article-list queries use the lead-image projection to generate signed thumbnails without loading
every body envelope. The projection follows the same image URL validation and content-version rules
as the manifest.

### Entry state

A sparse private user-to-entry record. Create this record only when its state differs from
subscription defaults or must survive independently.

Possible state:

- Explicitly read or unread exception
- Saved flag
- Coarse reading progress
- Last opened time

Avoid one row for every delivered user-entry pair.

Saved, progress, last-opened, and explicit read state are independently mutable components even when
they share one physical row. A read-state change cannot overwrite a newer value of another
component.

### Fetch attempt

Records operational history for one feed request, including safe diagnostics such as outcome class,
duration, HTTP status, validators used, entries observed, and the next scheduling input. Logs and
tables must not become a second copy of feed bodies.

### Admin audit

An append-only record for every admin mutation.

Contains:

- Actor application user ID
- Action and target type
- Target ID
- Timestamp
- Request correlation ID
- Small allowlisted metadata without credentials, content, or secrets

## Read-state model

Unread state combines a per-subscription watermark with sparse entry exceptions.

Each Feed owns a monotonic observation counter. The final publication transaction locks the Feed,
increments the counter, and assigns that position when a new Entry first becomes visible. Import and
mark-scope transactions lock affected Feeds in stable ID order before reading their counters, so a
concurrent Entry is either included in the captured watermark or receives a strictly later position.
Watermarks and scope boundaries use this position, not publisher dates, so a newly observed
backdated Entry is still newer than an earlier watermark. Feed merges reconcile positions and user
state as defined above.

### Subscribe or import

- Import currently available entries for browsing.
- Set the initial watermark so those entries begin read.
- Treat entries first observed after subscription as unread.

### Open

- Mark the entry read with a sparse exception when it is newer than the watermark.
- Keep the selected row in the current unread view until navigation leaves it.

### Mark unread

- Store an unread exception even when the entry lies behind the watermark.

### Mark scope read

Through beta, a scope is one active subscription, the active subscriptions captured from one folder,
or all active subscriptions. Saved and search-result lists are not watermark scopes and do not
expose this bulk action.

- Snapshot the exact member subscription IDs and each subscription's latest observed position when
  the command starts. Folder changes, new subscriptions, and new Entry observations after that
  snapshot are outside the operation.
- Advance each captured subscription watermark to its captured boundary without moving any watermark
  backward.
- Clear explicit read and unread markers at or before those boundaries. This marks the complete
  captured scope read, including entries previously marked unread, and removes read markers made
  redundant by the new watermarks.
- Preserve saved, progress, and last-opened state.
- Keep one server-owned undo context containing the operation ID, user, scope description, captured
  subscription IDs and boundaries, before-and-after watermarks, cleared read-marker before-images,
  and read-component mutation revisions.

Folder-wide and global mark-read operations update the member subscriptions rather than introducing
a second folder-level state model.

### Undo mark scope read

The mark-read commit sets `expires_at` from the PostgreSQL clock exactly 30 seconds later and
returns the operation ID and that timestamp with context state `available`. Contexts transition once
from `available` to `undone`, `superseded`, or `expired`; all three are terminal. Undo is accepted
only for `available` while the database clock is strictly before `expires_at`. At or after expiry,
the context is logically `expired` even before asynchronous cleanup records that state.

A retry with the same mark-read idempotency key returns the same operation and does not extend
expiry. Successful undo applies the restoration and records `undone` in one transaction. A retry of
an `undone` operation returns its stored success without touching watermarks again; `superseded` or
`expired` reports its terminal result and changes no state.

Only the latest committed bulk mark-read operation for a user remains undoable. A later bulk
mark-read commit atomically marks the prior unexpired `available` context `superseded`, including
when it came from another device; a logically expired context remains `expired`. Ordinary open,
mark-read, and mark-unread actions do not supersede it. Their read-component revisions make the
later action win for that Entry, even if it restates the value currently implied by the temporary
watermark. When undo could lower the watermark below that Entry, the later read action persists a
read marker instead of becoming a representation-level no-op.

Undo lowers each captured watermark to its before-value and restores every cleared read or unread
marker whose read component has not received a later mutation. It recreates a missing sparse marker
or merges it into the current row as needed. A later explicit read action remains read after the
watermark is lowered; a later explicit unread action remains unread. Missing or unsubscribed
subscriptions are skipped and never recreated.

Undo never changes saved, progress, or last-opened components, including changes made during the
window. It does not affect Entries observed after the captured boundary, subscriptions added later,
or subscriptions that joined the folder later. Moving a captured subscription to another folder does
not remove it from the undo because captured IDs, not current folder membership, define the
operation.

Example: subscription `S` has watermark 10, a read marker at Entry position 12, an unread marker at
position 8, and a saved Entry at position 15. Marking through boundary 20 sets the watermark to 20
and clears both read markers while retaining the save. An immediate undo returns the watermark to
10, restores position 12 as read and position 8 as unread, and leaves position 15 saved. If the user
explicitly marked position 14 unread after the bulk action, position 14 remains unread after undo.
An Entry first observed at position 21 is unaffected throughout.

## Retention

| Data                     | Retention                                                                |
| ------------------------ | ------------------------------------------------------------------------ |
| Invitation request       | 30 days from submission                                                  |
| Ordinary sanitized body  | 90 days                                                                  |
| Ordinary entry metadata  | 90 days                                                                  |
| Saved body and metadata  | Until no user keeps the entry saved                                      |
| Read/progress exceptions | While required by retained entries and product state                     |
| Bulk-read undo context   | Undoable for 30 seconds; deleted asynchronously after any terminal state |
| Orphaned object key      | Eight readable days from `orphaned_at`                                   |
| Deleted object version   | Eight more days after its delete marker                                  |

Image-cache policy lives in [`security.md`](security.md). Backup and recovery policy lives in
[`deployment.md`](deployment.md).

Retention jobs run in bounded batches. Start with indexed unpartitioned entry tables and add native
partitioning only after measured query or cleanup behavior justifies it.

Retention removes ordinary metadata and its sanitized body together from the user's perspective. It
must not leave a bodyless ordinary entry visible through beta. Deleting expired ordinary content
must not remove an object still referenced by a saved item. The retention transaction checks saved
references before removing the Entry and current-object reference, then starts the object's
eight-day readable orphan grace. Object cleanup does not repeat saved-state logic: the restrictive
Entry reference protects every retained ordinary or saved body. A later delete marker starts the
additional eight-day Object Storage version-recovery window.

PostgreSQL retains a non-queryable Entry shell containing only opaque identity and coordination
fields until its publication intents and objects move to the deletion outbox. The ownership foreign
key is restrictive; retention never cascade-deletes Content object rows. The shell is not retained
ordinary metadata, cannot appear in product queries, and cannot keep an object current by itself.

## Unsubscribe

When a user unsubscribes:

- Remove the subscription and ordinary private entry state for that feed.
- Preserve saved state and the metadata/content required to render saved items.
- Preserve the global feed and entries while other subscribers or retained saved items reference
  them.
- Garbage-collect globally orphaned data asynchronously after ordinary retention, then apply the
  eight-day readable orphan grace and additional eight-day deleted-version recovery window.

## Account deletion

Account deletion is immediate from the user's perspective.

Delete:

- Kratos identity and sessions
- Application user profile
- Invitations owned by or reserved for the user where policy permits
- Folders and subscriptions
- Private entry state and preferences
- User-identifying analytics links

Retain only globally shared public feed and entry records that have another valid reason to exist.
Admin audit data may retain the deleted actor's opaque ID without retaining identity traits.

## Export

Through beta, OPML export contains active subscriptions and folder structure using standard OPML
outlines. Reader does not export preferences, read state, saved items, reading progress, article
bodies, or image files.

## Open schema details

These details remain deferred to schema and fixture design:

- Primary-key representation
- Index selection and partition thresholds
- Audit retention duration
- Physical table and index representation for import runs and temporary undo context
