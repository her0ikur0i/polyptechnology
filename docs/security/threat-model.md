# Threat model

## Protected assets

Owner identity, provider credentials, project secrets, source code, business
data, production systems, contract/audit history, and spending authority.

## Trust boundaries

- Internet -> Cloudflare -> control API.
- Uploaded/untrusted content -> context builder.
- Model output -> command/capability gate.
- Control plane -> isolated worker.
- Worker -> project repository/network/provider.
- Project -> curated shared knowledge.

## Primary threats and controls

| Threat | Required controls |
|---|---|
| Anonymous dashboard control | Cloudflare Access plus origin JWT validation |
| Prompt/tool injection | content classification, capability checks, no prompt authorization |
| Secret exfiltration | scoped injection, redaction, egress policy, rotation |
| Host compromise by worker | container isolation, no host Docker socket, resource limits |
| Duplicate destructive work | idempotency keys, durable attempts, scoped approval |
| Cross-project data leak | project scope on every retrieval and artifact |
| Knowledge poisoning | provenance, verification, curation lifecycle |
| Dependency compromise | lockfiles, SBOM, license/vulnerability/secret scans |
| Budget exhaustion | per-attempt/task/contract/project/provider limits |
| Audit tampering | append-only events, checksums, restricted mutation |

Production startup must fail closed if authentication or required secret
references are missing.
