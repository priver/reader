# 0009: Publish content objects through PostgreSQL intents

Status: Accepted

## Context

Entry metadata and content envelopes have one user-visible lifetime, but PostgreSQL and Object
Storage do not share a transaction. A worker can stop before an upload, receive an ambiguous upload
result, stop after an upload, or lose the result of the PostgreSQL transaction that publishes the
new reference. Retention and backfills can race those retries. Bucket versioning can recover bytes
after a deletion, but it cannot decide whether an Entry or saved item still needs them.

The protocol must therefore make an object readable before exposing its reference, track every
possible upload without routine bucket listing, and make an object impossible to reference before
deleting it.

## Decision

### Authority and timing

PostgreSQL is authoritative for Entry visibility, current references, content versions,
representation digests, publication state, leases, recovery deadlines, and deletion eligibility.
Object Storage owns only immutable envelope bytes, their exact version IDs, delete markers, and
recoverable noncurrent versions. Object age, list results, tags, ETags, and latest-version state
never decide whether content is live.

Use these beta timing bounds, measured with the PostgreSQL clock:

| Bound                              | Value  | Purpose                                                                       |
| ---------------------------------- | ------ | ----------------------------------------------------------------------------- |
| Publication lease                  | 15 min | Exclusive, fenced ownership of one staged publication                         |
| Lease heartbeat                    | 1 min  | Renews work that is still making progress                                     |
| Object Storage request             | 2 min  | Maximum time for one `PUT`, `GET`, or `DELETE`                                |
| Readable orphan grace              | 8 days | Delay from `orphaned_at` before creating a delete marker                      |
| Deleted-version recovery           | 8 days | Minimum noncurrent-version lifetime after the delete marker is created        |
| Incomplete multipart-upload expiry | 1 day  | Defense in depth; content publication itself uses one bounded single-part PUT |

The eight-day floor covers the seven-day PostgreSQL point-in-time recovery horizon, the eight-hour
recovery-time target, and margin. Increase both eight-day windows before increasing either database
recovery target. An orphan remains directly readable for at least eight days, then remains
recoverable by exact Object Storage version for at least eight additional days.

### PostgreSQL records

Each publication has a random immutable object ID and an opaque key such as
`content/objects/<object-id>.json.gz`. Do not derive a reusable key from Entry ID or proposed
content version. Retries of one publication reuse its key; a different publication always uses a new
key. Do not share one content object between Entries.

A Content object record is created and committed before any storage request. It contains:

- Owning Entry and immutable object key
- Base current-object ID, content version, and representation digest
- Publisher-update, storage-rewrite, or recovery-repair operation kind; target format; and pending
  typed Entry metadata
- Proposed content version and candidate representation digest
- Expected compressed length and SHA-256, envelope integrity digest, and format versions
- Exact Object Storage version ID once known
- `staged`, `verified`, `current`, or `orphaned` state and its transition times
- Monotonic publication fence, lease expiry, `orphaned_at`, and `gc_not_before`

Pending metadata contains the title, authors, dates, publisher URL, and projections needed to finish
publication after a crash. PostgreSQL does not keep a second copy of the article body. A new Entry
may exist as an internal shell to reserve its feed-scoped identity, but product queries require a
non-null current object and cannot expose that shell.

The Content object's owning-Entry foreign key and the Entry's current-object foreign key are both
restrictive and never cascade. An unqueryable Entry shell remains until every owned Content object
has moved to the deletion outbox. PostgreSQL permits at most one active `staged` or `verified`
publication per Entry. Content object states move only in these directions:

```text
staged -> verified -> current -> orphaned -> deletion outbox
staged -----------------------> orphaned
verified ---------------------> orphaned
restored noncurrent base -----> recovery quarantine
```

The deletion outbox retains the immutable key, optional exact version ID, expected digests, terminal
disposition, delete result, and recovery expiry after the Content object record is removed. Moving
an eligible record into this outbox is the deletion claim and makes a future Entry reference fail
its foreign-key check. A separate recovery-quarantine record can hold an unowned key and version
found after PostgreSQL restore. It has no Entry metadata, can never be published, and exists only to
drive inventory reconciliation and eventual cleanup.

### Publication

1. The worker selects the deterministic feed candidate, creates the canonical envelope and gzip
   bytes, and calculates the representation, envelope-integrity, and compressed-byte digests.
2. In a short PostgreSQL transaction, it locks the Entry. An unchanged current representation is a
   no-op for publisher ingestion. An explicit storage rewrite continues only when its target format
   or expected compressed bytes differ from the current object. A recovery repair continues only
   when the restored exact version is not storage-current, even when format and bytes are unchanged.
   The worker reuses an active intent for the same operation, candidate, target format, and
   compressed digest; waits for a different live intent; or fences and orphans a different expired
   intent before inserting a new one.
3. The intent records the current Entry state as its compare-and-swap base. A publisher change
   proposes base version plus one; first publication proposes version 1. A storage-only rewrite may
   propose the base version only when the representation digest is unchanged. A recovery repair must
   preserve the base version, format, compressed digest, and representation digest.
4. After the intent commits, its lease holder conditionally creates the random key with
   `If-None-Match: *`, the required content headers, length, and transport checksum. Content uploads
   are single-part. A fresh read-only policy check must pass, and content-bucket policy denies a PUT
   without the create-only precondition, so an existing key cannot be overwritten even by a
   defective worker.
5. The worker resolves a successful, precondition-failed, or ambiguous PUT with a full bounded GET.
   It records the returned exact version ID and verifies compressed length and SHA-256. It then runs
   the same strict decoder as the API, including gzip bounds, duplicate-property rejection, schema
   dispatch, envelope integrity, content version, placeholders, image URLs, and lead image. Finally,
   it combines the decoded body with the pending Entry metadata and reconstructs the expected
   representation digest. A HEAD response, ETag, PUT response, or provider checksum alone is not
   sufficient.
6. If an object is present with different bytes or fails verification, the worker fences and orphans
   the intent, alerts, and never overwrites or publishes that object. If no object is present, the
   upload remains retryable while its lease is live. A valid object is marked `verified` only while
   the worker holds the current publication fence.
7. In one final PostgreSQL transaction, the worker locks the Entry and verified object, checks its
   lease and fence, checks the persisted feed-refresh generation, and compares the Entry's current
   object, version, and digest with the captured base. It atomically installs all proposed metadata,
   content version, representation digest, and current-object reference; marks the new object
   `current`; and makes the former object `orphaned` with an eight-day grace. For a recovery repair,
   that transaction instead moves the restored noncurrent base into recovery quarantine under its
   existing lifecycle deadline.
8. That final commit is the only publication point. A new Entry becomes queryable there. No
   PostgreSQL transaction remains open during an Object Storage request.

The proposed number in an intent is not an assigned content version. An abandoned proposal does not
consume it, so the next successful publisher change still commits exactly current version plus one.
A persisted feed-refresh generation fences a timed-out worker that resumes after a newer fetch;
River uniqueness is only a scheduling optimization. Backfills and recovery repairs use the same
base-object compare-and-swap even when they do not belong to a feed refresh.

### Retry and recovery

Lease takeover increments the publication fence. Every later state change and the final publication
transaction require that fence. No storage request starts with less than its two-minute request
bound remaining on the lease. A stale holder can finish an upload under its unique key, but it
cannot change PostgreSQL and its tracked object becomes an orphan.

Recovery uses the exact intent and key:

| Failure boundary                                       | Recovery                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Before intent commit                                   | Nothing changed; retry candidate selection                                                             |
| Intent commit result is unknown                        | Resolve by Entry, base, operation, target format, candidate digest, and compressed digest before PUT   |
| After intent commit and before upload                  | Regenerate identical bytes and resume, or orphan the intent after fenced takeover                      |
| PUT fails or its result is unknown                     | GET the exact key; never issue a blind overwrite                                                       |
| After upload and before verification                   | Take over, GET, and perform the complete verification                                                  |
| After verification and before publication commit       | Reverify the exact version, then retry the base compare-and-swap                                       |
| Publication commit result is unknown                   | A matching current object and digest mean success; otherwise retry or orphan after inspecting the base |
| Base changed, Entry disappeared, or refresh was fenced | Orphan the intent; never rewrite its envelope or proposed version                                      |

A recovery worker can finish a verified intent without the source XML because PostgreSQL retains the
pending Entry metadata and Object Storage retains the body. A staged intent with no object and no
reproducible bytes is orphaned rather than guessed. Feed merges and retention fence affected
refreshes and intents while holding the relevant Entry locks.

### Orphan cleanup and deletion recovery

Publication replacement, retention, and abandonment set `orphaned_at` and `gc_not_before` in
PostgreSQL. Retention first checks saved references and removes user-visible Entry metadata and its
current reference in one transaction. Saved-item policy therefore decides whether an Entry may be
removed; object cleanup does not reimplement that policy.

The worker may claim an orphan for deletion only when all of these conditions hold:

- State is `orphaned`, the current PostgreSQL time reached `gc_not_before`, and the eight-day grace
  was measured from the latest transition that could make the object needed.
- No Entry current reference or explicit migration/recovery pin exists. Every supported pin uses a
  restrictive PostgreSQL foreign key to the Content object record.
- No publication lease is live, and its expiry plus the two-minute request bound has passed.
- A fresh read-only check confirms content-bucket versioning, create-only PUT enforcement, no
  current-key expiry, and the minimum deleted-version lifecycle.
- The same PostgreSQL transaction deletes the Content object record into the deletion outbox.

The restrictive current-reference foreign key serializes the deletion claim with publication. If a
reference commits first, the claim fails; if the claim commits first, no later publication can
reference that object. After the claim, cleanup waits out any final request bound and checks the
current key before changing Object Storage:

- If the key is absent and has no current delete marker, record `never_uploaded`; do not create an
  empty delete marker. This is the terminal path for a pre-upload failure.
- If the expected data version is current, persist the delete-attempt start time and send
  `DeleteObject` without a version ID. It never permanently deletes a data version.
- If a current delete marker already hides the key, record its version ID and do not send another
  delete. If a different data version is current, quarantine and alert.

After a failed or ambiguous request, cleanup checks current-key state again before considering
another delete. It sends a new delete only when the expected data version is still current, avoiding
multiple markers. The request start plus eight days is a conservative guaranteed-recovery deadline
because the bounded request can create its marker only after that time; a known failed attempt that
is retried records a new start and extends the deadline. Current delete-marker state and successful
exact-version read-back confirm deletion. Retain the outbox tombstone through that deadline.

Routine workers use exact keys from PostgreSQL and cannot list the bucket. Lifecycle policy never
expires a current content key by age. It retains data versions for at least eight days after a
delete marker, retains the marker while its data version is recoverable, and only then purges
obsolete versions.

A PostgreSQL point-in-time restore can forget objects uploaded after the selected restore point.
Disaster recovery therefore stops old workers, revokes their write access, proves that writes are
denied, waits out the two-minute request bound, restores PostgreSQL with publication and cleanup
disabled, and verifies every restored reference by exact key, version, and digest. A temporary
recovery-only identity inventories keys and versions. Unknown current data keys become unowned
recovery-quarantine records with a new eight-day readable grace. Unknown noncurrent versions and
delete markers remain read-only quarantine inventory until their existing lifecycle expires; the
recovery process does not make them current or reset their age.

Every restored Entry reference must also name the storage-current data version. When the exact
referenced version is hidden by a later delete marker or superseding data version, its original
noncurrent lifecycle still applies and verification alone is insufficient. Before promotion, a
controlled recovery repair uses the normal worker publication permission to read and fully verify
that exact version, conditionally write the same envelope bytes to a fresh random key, and switch
the Entry through a `recovery_repair` intent with the same content version and representation
digest. The same transaction moves the former object metadata into recovery quarantine with its
existing lifecycle deadline rather than promising a new orphan grace. Recovery fails if the old
exact version cannot be read or any fresh reference is not storage-current after repair.

The inventory identity is revoked after reconciliation and before normal workers start. A live
production bucket is never destructively reconciled while its old database is authoritative.

## Consequences

- API reads request the exact stored Object Storage version and still verify the envelope, so an
  accidental delete marker does not silently select different bytes.
- Random immutable keys and PostgreSQL fencing make retries safe without a cross-store transaction
  or staging-object copy.
- The eight-day readable grace and additional version-history window consume storage but cover the
  documented PostgreSQL recovery horizon and operational recovery time.
- Routine cleanup needs no bucket-list permission, but disaster recovery needs a tightly scoped,
  temporary inventory identity to reconcile objects forgotten by a PostgreSQL restore.
- Provider validation must demonstrate bucket-policy enforcement of conditional create, full
  read-after-write, exact-version reads, delete-marker inspection, configuration reads, and
  lifecycle timing before this protocol is enabled in production.
