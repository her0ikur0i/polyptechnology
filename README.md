# Polyp AI Factory

Polyp is a single-owner AI software factory. The Master Dashboard is its control
plane: it turns conversations into approved contracts, delegates bounded work to
agents, verifies results, and operates independently isolated generated projects.

The system is rebuilt contract-by-contract. A contract contains multiple
milestones and produces exactly one quality-gated Git commit/push after every
milestone and final regression gate pass.

Current delivery state is recorded in `docs/contracts/`.

## Local verification

```bash
npm ci
npm run verify
```

No production mutation is permitted from a development command.

Current durable approval and Telegram gateway operations are documented in
`docs/operations/telegram-approvals.md`. Deterministic tests never send live
Telegram messages.
