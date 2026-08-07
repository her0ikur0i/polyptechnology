# Domain event envelope

Every durable state transition emits an event using this envelope:

```json
{
  "eventId": "evt_...",
  "schemaVersion": 1,
  "type": "task.attempt.started",
  "occurredAt": "RFC3339 timestamp",
  "producer": "orchestrator-worker",
  "correlationId": "contract or request id",
  "causationId": "event or command id",
  "scope": {
    "projectId": null,
    "contractId": "contract_...",
    "milestoneId": "milestone_...",
    "taskId": "task_...",
    "attemptId": "attempt_..."
  },
  "classification": "internal",
  "payload": {}
}
```

Events are immutable. Schema changes are additive within a version. Redaction is
performed before persistence and before delivery to the browser.
