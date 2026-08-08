# Disaster recovery and backup runbook

## Targets and coverage

- RPO: at most 24 hours after the external daily schedule is activated.
- RTO: two to four hours for the initial single-host release.
- Weekly and monthly immutable retention supplements daily backups.
- PostgreSQL covers contracts, work, attempts, approvals, conversations, project
  factory, knowledge, events, incidents, manifests, and operational metadata.
- Artifact objects, generated repositories, deployment configuration, and encrypted
  secret material are separate backup sets joined by manifest references.

## Backup

Run `scripts/backup-postgres.sh` only on an encrypted local staging volume with mode
0700, then transfer the dump and checksum to a provider-encrypted immutable target.
Record the final size/digest, migration head, covered domains, encryption state, and
opaque key reference in `backup_manifests`. Never place database passwords in command
arguments, logs, manifests, or the repository; use a protected `.pgpass` or provider
credential mechanism. Remove staging files through the approved retention process
only after remote integrity verification.

## Restore drill

1. Provision a clean, isolated PostgreSQL database; never restore over live state.
2. Retrieve the immutable artifact and verify its checksum before opening it.
3. Run `scripts/restore-postgres.sh` with the clean target.
4. Compare migration head, public table count, critical domain row counts, and
   manifest-covered artifacts with the source evidence.
5. Run integration, owner-command, supervisor recovery, and synthetic lifecycle tests.
6. Record `restore_verifications` with duration and evidence digest.
7. Destroy a disposable drill environment only under the test-environment policy;
   production recovery requires owner incident/cutover approval.

The CONTRACT-010 drill restored 48 tables and passed all targeted application tests.
The early single-host topology remains a known availability limitation; external
backup scheduling and a restore operator are required before production cutover.
