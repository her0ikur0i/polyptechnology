# M5 reconciliation evidence — stranded attempts, captured 2026-08-12

This file is the evidence `scripts/reconcile-provider-attempt.ts` requires: a
concrete, checkable record of why each attempt below is safe to close as
`failed_no_charge`, captured before any reconciliation ran and never edited
afterward. Its own SHA256 is what `ai_attempt_reconciliations.evidence_sha256`
points at for every row in this list, so re-hashing this file is how anyone
can independently verify the reconciliation was not backed by an invented
hash.

## Query

```sql
SELECT id, provider_id, requested_model_id, reserved_cost_usd_micros,
       attribution->>'taskId' AS task_id, created_at
  FROM ai_gateway_attempts
 WHERE outcome = 'outcome_unknown' AND provider_request_id IS NULL
 ORDER BY created_at ASC;
```

Run against `polyp-staging-pg` at 2026-08-12T11:xx UTC (immediately before
reconciliation). 37 attempts held `outcome_unknown` in total; this query
returns 36 of them.

## Why `provider_request_id IS NULL` is sufficient evidence on its own

`provider_request_id` is not a call id — CONTRACT-017A's evidence
(`docs/contracts/CONTRACT-017A/`) established it as the provider's own
session identifier, assigned only once a provider has actually accepted a
request and started a session. `AiGateway.execute()` sets it exactly there,
never earlier. An attempt row with `provider_request_id IS NULL` therefore
recorded a reservation and nothing else: the process holding it died (M1's
diagnosis — `TasksMax=64` killing the supervisor mid-Codex-attempt, or
CONTRACT-017C's pre-classification-fix stranding) before any provider ever
saw the request. There is no external ledger to reconcile against because no
external call was ever made — this is the one class of `outcome_unknown` row
this repository can close on its own evidence, which is exactly why
`reconcileUnknownAsFailed()` refuses any row where `provider_request_id` is
**not** null (`src/gateway/postgres-ledger.ts`): those need a real check
against the provider's own billing, which this evidence cannot supply and
does not claim to.

**One attempt is excluded on purpose**:
`e9436790-09ee-4dbc-bf23-a6166ba4abf4` (claude, claude-sonnet-5, reserved
\$0.20, created 2026-08-10T07:45:49.135Z) has `provider_request_id` set. It is
left in `outcome_unknown`, holding its \$0.20 reservation, until it can be
checked against Anthropic's own usage record — not reconciled here.

## The 36 attempts, frozen

| id                                   | provider | model           | reserved | task_id                              | created_at               |
| ------------------------------------ | -------- | --------------- | -------- | ------------------------------------ | ------------------------ |
| b1c6f043-4f00-4039-8a46-0b20bc005c75 | claude   | claude-sonnet-5 | $0.20    | d0e26d29-d406-4093-a6a2-c920672a23d3 | 2026-08-10T08:07:58.323Z |
| faf34722-dfcd-4182-b824-de66e8c73dd1 | claude   | claude-sonnet-5 | $0.20    | 47a0ed46-7dc2-44ec-835f-a32e44f616db | 2026-08-10T10:38:29.618Z |
| e80bf38b-729d-4047-b7c7-c7e0777c815d | claude   | claude-sonnet-5 | $0.20    | 1a1a2593-2aaa-4097-b135-72c8fccb360a | 2026-08-11T04:08:04.579Z |
| 69409211-9b22-4ef5-81c6-7f1bd3b7b785 | claude   | claude-sonnet-5 | $0.20    | 7497bea3-4992-4be3-ace0-9a675dbffd09 | 2026-08-11T04:09:36.583Z |
| 66101d28-e3a8-4724-8071-f7cf8832696d | claude   | claude-sonnet-5 | $0.20    | 98f1f081-8f54-4f3e-b88d-006b1c299e06 | 2026-08-11T05:04:38.409Z |
| 62cc216e-dfa0-4573-815e-aa6a3393f010 | claude   | claude-sonnet-5 | $0.20    | 98f1f081-8f54-4f3e-b88d-006b1c299e06 | 2026-08-11T05:04:40.522Z |
| abf966f0-7e97-495a-8169-e198cb590846 | claude   | claude-sonnet-5 | $0.20    | 98f1f081-8f54-4f3e-b88d-006b1c299e06 | 2026-08-11T05:04:42.588Z |
| d2dd9701-6a68-4b95-9f16-b1c3cea46ed1 | claude   | claude-sonnet-5 | $0.20    | af5ded4c-05f3-4fa8-883b-b9d292bf3651 | 2026-08-11T05:05:45.624Z |
| c9f30891-5717-40eb-9ab0-ebfb523752cf | claude   | claude-sonnet-5 | $0.20    | af5ded4c-05f3-4fa8-883b-b9d292bf3651 | 2026-08-11T05:05:47.711Z |
| 8bfd2e4d-773e-4ab0-b7e7-3ccae57d9ff3 | claude   | claude-sonnet-5 | $0.20    | af5ded4c-05f3-4fa8-883b-b9d292bf3651 | 2026-08-11T05:05:49.778Z |
| 1e27a65a-192f-4300-9dc5-0bfb1b64e990 | codex    | gpt-5.6-terra   | $0.50    | b31a3dc9-c5ab-4549-a02e-d43813e67082 | 2026-08-11T09:41:33.693Z |
| c5aaf9f8-2b18-4880-9429-229bc5f27364 | codex    | gpt-5.6-terra   | $0.50    | b31a3dc9-c5ab-4549-a02e-d43813e67082 | 2026-08-11T09:41:39.217Z |
| d7d5f3fc-5060-470f-ba27-9f9b9fc14829 | codex    | gpt-5.6-terra   | $0.50    | b31a3dc9-c5ab-4549-a02e-d43813e67082 | 2026-08-11T09:41:47.584Z |
| ac4352d2-eb60-4c00-b140-d1fa5df7f637 | codex    | gpt-5.6-terra   | $0.50    | 5e14f4f3-d588-44c3-89f5-2ddeb56f9bdd | 2026-08-11T09:51:42.740Z |
| e1433192-9d84-4050-83c1-4865dd6d332b | codex    | gpt-5.6-terra   | $0.50    | 5e14f4f3-d588-44c3-89f5-2ddeb56f9bdd | 2026-08-11T09:52:24.093Z |
| 7b0b987a-68b5-492b-b77f-a7b793ca5087 | codex    | gpt-5.6-sol     | $0.50    | 5e14f4f3-d588-44c3-89f5-2ddeb56f9bdd | 2026-08-11T09:58:07.153Z |
| 75278836-02d7-4738-bd80-272fac6e796e | codex    | gpt-5.6-terra   | $0.50    | 0af8d9f2-e242-4cb7-ba1c-d70c02d084a8 | 2026-08-11T11:05:36.487Z |
| 3677b4ff-1262-4218-80a3-31e878b17a46 | codex    | gpt-5.6-terra   | $0.50    | 0af8d9f2-e242-4cb7-ba1c-d70c02d084a8 | 2026-08-11T11:06:18.906Z |
| a2b29752-6c3c-493f-b5fb-1f53ea547bb3 | codex    | gpt-5.6-terra   | $0.50    | 0af8d9f2-e242-4cb7-ba1c-d70c02d084a8 | 2026-08-11T11:07:01.097Z |
| 4efca0ff-1b31-408b-ab0e-ce12ec97c33f | codex    | gpt-5.6-terra   | $0.50    | 4c6eef00-2a9b-4ee9-94f6-557677057c90 | 2026-08-11T11:29:45.920Z |
| d6ab21b4-069f-4387-8a62-2d2020b57eb9 | codex    | gpt-5.6-sol     | $0.50    | 4c6eef00-2a9b-4ee9-94f6-557677057c90 | 2026-08-11T11:30:47.351Z |
| 31545f40-a427-4673-a5e2-e98d83400b3d | codex    | gpt-5.6-terra   | $0.50    | c5f72851-1461-44d8-bc2e-9abc777eb348 | 2026-08-11T11:53:30.113Z |
| fbba9128-5ee6-456a-948b-94f690c86963 | codex    | gpt-5.6-terra   | $0.50    | c5f72851-1461-44d8-bc2e-9abc777eb348 | 2026-08-11T11:54:34.129Z |
| e068f8dc-a498-4ca7-8168-07e5379ee13e | codex    | gpt-5.6-terra   | $0.50    | 59946ef1-4840-479b-82cc-77bf3508bb84 | 2026-08-11T12:05:42.291Z |
| 0d7233ee-9744-4f51-bc31-6906649aaeea | codex    | gpt-5.6-sol     | $0.50    | 59946ef1-4840-479b-82cc-77bf3508bb84 | 2026-08-11T12:06:55.001Z |
| 3197818b-6c48-416a-8545-15d45c54d483 | codex    | gpt-5.6-sol     | $0.50    | 59946ef1-4840-479b-82cc-77bf3508bb84 | 2026-08-11T12:07:34.103Z |
| cd6f8a26-b02f-4a97-bbf5-3747276c131e | codex    | gpt-5.6-sol     | $0.50    | 97b4aa2a-4408-43fc-ace9-a36e2b56ad5a | 2026-08-11T12:21:09.199Z |
| 3f66c084-51f4-404a-bfa9-a40e4f56f6e3 | codex    | gpt-5.6-sol     | $0.50    | 97b4aa2a-4408-43fc-ace9-a36e2b56ad5a | 2026-08-11T12:21:45.860Z |
| 3aefd708-93d3-4f65-9ebe-ae8cfaecce54 | codex    | gpt-5.6-terra   | $0.50    | 5e7b66a2-dc3d-455d-b2fa-29061b239399 | 2026-08-11T12:40:44.373Z |
| 66c02106-a7c1-40c2-8ae4-df21d6dec3dc | codex    | gpt-5.6-terra   | $0.50    | 09a8422c-d07c-4335-a72a-db60e76b132e | 2026-08-11T14:10:57.807Z |
| 39c562c7-2c7b-4269-a986-c07c5214ec13 | codex    | gpt-5.6-sol     | $0.50    | 09a8422c-d07c-4335-a72a-db60e76b132e | 2026-08-11T14:12:58.657Z |
| a5155b30-aaec-4a21-885c-4bd673985025 | codex    | gpt-5.6-sol     | $0.50    | 09a8422c-d07c-4335-a72a-db60e76b132e | 2026-08-11T14:13:34.093Z |
| 8265f2bc-7ba9-44e7-b1c1-4cac83784784 | codex    | gpt-5.6-terra   | $0.50    | 571ce10d-da46-4340-b86e-821b0aecea05 | 2026-08-11T14:29:39.231Z |
| 44778ab3-432f-4ad8-8535-d8c52e0020ba | codex    | gpt-5.6-sol     | $0.50    | 571ce10d-da46-4340-b86e-821b0aecea05 | 2026-08-11T14:30:18.280Z |
| 7ead4160-3e78-4804-a5df-7da0735fe8bb | codex    | gpt-5.6-sol     | $0.50    | 571ce10d-da46-4340-b86e-821b0aecea05 | 2026-08-11T14:31:00.569Z |
| e9df99ef-c9a2-4c3d-b308-6cd4b4fd9230 | claude   | claude-sonnet-5 | $0.50    | 46e044dd-2e9e-46fe-8eee-661d0823c3e5 | 2026-08-12T10:35:02.675Z |

**36 rows, $15.00 total reserved.** The last row is CONTRACT-017D M2's own
first (pre-fix) drill run — its `claude-sonnet-5` rejection is the $0.50 M2's
evidence flagged as "left for later, not this milestone." This is that later.

Every `codex` row above sits inside the exact incident windows M1 diagnosed
(2026-08-11 09:41–14:31 UTC): the supervisor dying mid-`codex exec` under
`TasksMax=64`. Every `claude` row at $0.20 predates M1 and matches
CONTRACT-017C's pre-classification-fix stranding
(`conversation_reply`'s per-attempt cap, `src/orchestrator/reply-task.ts`).
