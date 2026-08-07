# First release acceptance criteria

The first release is complete only when all scenarios pass:

1. An authenticated owner creates a project-neutral conversation.
2. A discussion becomes a reviewed contract with milestones and budget.
3. The contract survives API, worker, and host restarts without duplicated work.
4. An isolated worker delegates a bounded coding task and stores its evidence.
5. Deterministic verification rejects an intentionally incorrect result.
6. A successful contract produces one scoped commit and one push.
7. Provider usage and cost are attributed to project, contract, task, and attempt.
8. Factory Live View displays real versioned events and pauses when hidden.
9. A dangerous action cannot run without a valid, scoped approval.
10. Backup restore recreates durable state in a clean environment.
11. No mutation endpoint is anonymously accessible from the public hostname.
12. Emergency stop prevents new jobs and safely drains or cancels active work.
