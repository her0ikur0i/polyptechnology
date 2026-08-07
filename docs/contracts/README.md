# Contract protocol

Contracts are the only unit of delivery and Git publication.

Rules:

1. A contract has bounded scope, acceptance criteria, rollback, budget, file
   ownership, ordered milestones, and objective gates.
2. Milestones may create local recovery patches and evidence but never push.
3. The final gate validates the integrated contract diff and regression suite.
4. Exactly one scoped commit/push occurs after every gate passes.
5. Failure leaves the contract resumable and does not weaken a gate.
6. Changes outside the contract file manifest block completion.
