# Release hardening statement

The control plane has no implicit prompt authority. Every mutation crosses domain
validation and, where applicable, owner authentication, timing-safe CSRF, policy,
capability, lease/fence, scoped approval, immutable evidence, and verification.
Production configuration fails closed without access authentication and Telegram
identity restrictions. Secret values remain outside source and model context.

Background execution now performs allowlisted, already-authorized queued work. It
does not author contracts, approve risk, resolve secrets, deploy, or change DNS.
Emergency stop is rechecked by task heartbeat, cancels active attempts, removes
leases, and prevents new claims. Output observation hashes are auditable but do not
count as verified evidence or suppress retry; only matching expected digests reach
success.

The systemd artifact runs Node `--jitless` under `MemoryDenyWriteExecute`, a dedicated
identity, zero capabilities, strict filesystem/kernel/home/device protections,
limited address families, and CPU/memory/process bounds. Offline
`systemd-analyze security` scored exposure 3.9 (`OK`). Installation is deliberately
not performed without the owner-approved environment, identity, paths, and release.

CI action revisions and the PostgreSQL service image are immutable-digest pinned.
The pipeline starts from a clean database and runs all migrations, tests, dashboard
accessibility/build, dependency audit, secret-pattern, and diff gates. Production
deployment and post-deploy rollback gates remain approval-controlled cutover steps.
