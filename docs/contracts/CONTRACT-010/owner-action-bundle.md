# Owner Action Bundle — perform only after reviewing CONTRACT-010 evidence

This is the intentionally final segment containing every action that needs owner
authority or external production state. None is silently implied by contract
acceptance.

1. **Production identity and release activation.** Approve the exact immutable
   release SHA, create/confirm the `polyp-factory` system user, install the built
   release at `/opt/polyp-ai-factory/current`, provision the root-owned 0600
   `/etc/polyp-ai-factory/sequence.env`, apply migration 0007 after backup, install
   the reviewed unit, then enable/start it. Confirm watchdog, readiness, resource
   limits, and compact summaries before leaving it unattended.
2. **Access/DNS/cutover.** Approve the Cloudflare Access application, authorized
   owner identity, localhost-only origin/tunnel mapping, hostname/DNS change, and
   post-cutover rollback window. Do not expose a direct public mutation origin.
3. **Telegram live connection.** Confirm the existing bot-token secret reference
   and authorized chat/user IDs in the dashboard, approve one paid/live connectivity
   probe, and verify Approve/Deny callback delivery and audit from the intended
   identities. Absence/failure must remain fail-closed.
4. **External encrypted backups.** Select the provider-encrypted immutable target
   and key reference, approve daily/weekly/monthly schedules and retention, assign a
   restore operator, and run the first external restore drill. The tested local
   procedure alone does not satisfy off-host disaster protection.
5. **Production deployment authority.** Approve staging, health window, production
   promotion, post-deploy verification, and rollback separately. No generated dummy
   project from acceptance is a production deployment.
6. **Ambiguous provider reconciliation.** Reconcile CONTRACT-008 Claude provider
   request `66717047-593d-4976-b133-0a04d475e341`; its ledger reservation remains
   intentionally `outcome_unknown` because the provider dispatched a session but
   returned no attributable result envelope.

Until items 1–5 are approved and completed, the repository is release-ready but not
claimed as production-cut-over. The interactive goal can finish safely; unattended
execution begins only after item 1 activates the reviewed supervisor service.
