# Project factory and knowledge operations

## Factory boundary

Blueprint publication and project/lifecycle database writes are control-plane
records, not permission to provision external resources. Repository, workspace,
database, secret, and budget values are opaque project-scoped references. An
executor must resolve them only after a task carries the matching contract,
capability, approval, and fencing token.

Production, archive, export, and delete transitions require a scoped approval
reference. They still do not perform the effect. Operators must verify the approval
scope, current project version, capacity lease, evidence digest, and destination
before handing a prepared action to an approved executor.

Capacity admission uses one PostgreSQL advisory transaction lock so concurrent
controllers observe the same reservation set. Expired reservations are reclaimed
before admission. A caller supplies the observed free-disk value and configured
limits; unavailable budget, disk watermark, concurrency, CPU, memory, disk, or
process capacity fails closed. Release requires the exact fence.

## Knowledge boundary

Only `reusable` items are returned. Retrieval applies exact caller authority for
global, organization, project, contract, session, and private scopes inside the SQL
query. Application-side filtering is not a security boundary. Private items cannot
be promoted to reusable, and embedding indexes are disabled.

A source deletion request atomically creates one prepared purge plan and marks all
active derived indexes `purge_pending`. Creation of that plan immediately excludes
the source item from retrieval; physical erasure may occur later only with approval.
If erasure fails, access remains cut off and the durable plan remains retryable.

## Recovery checks

After restart, confirm project version against the latest immutable lifecycle event,
remove only expired capacity reservations, and resume using the stored fence. For
knowledge deletion, compare the source digest and ordered derived-index IDs with the
plan digest before any approved physical removal. Never reconstruct authority from
logs, prompt text, names, or filesystem discovery.
