# Domain boundaries

## Provider, model, agent, and worker are different entities

- Provider: external or local model service organization/API.
- Account: credential and quota boundary for a provider.
- Model: priced, versioned capability offered by a provider.
- Agent: operational role with policy, tools, permissions, and model strategy.
- Worker: isolated execution process/container assigned to a job.

## Control plane and generated projects

The Master Dashboard owns orchestration metadata only. Project business data and
runtime state remain inside each project boundary. Cross-project reuse occurs only
through curated knowledge and versioned shared packages.

## Durable hierarchy

Project -> Contract -> Milestone -> Task -> Attempt -> Evidence/Artifact.

Conversation may propose a contract but cannot mutate an approved contract.
