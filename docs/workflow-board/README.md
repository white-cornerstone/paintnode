# Workflow Board 2.0

This folder is the durable product and engineering source of truth for the
next generation of PaintNode's workflow board, currently called **Creative
Blueprint**.

GitHub issues and milestones track execution. These documents describe why the
work exists, the product boundaries, the technical direction, and the release
gates. Do not duplicate live issue status here.

## GitHub execution

- [Creative Blueprint umbrella tracker](https://github.com/white-cornerstone/paintnode/issues/57)
- [Workflow Board 2.0: Foundation](https://github.com/white-cornerstone/paintnode/milestone/1)
- [Creative Blueprint: MVP](https://github.com/white-cornerstone/paintnode/milestone/2)
- [Recipes & Portability](https://github.com/white-cornerstone/paintnode/milestone/3)

## Documents

- [Product vision](vision.md) — users, jobs, principles, scope, and success.
- [Market research](research-2026-07.md) — competitor evidence and product gaps.
- [Architecture](architecture.md) — WorkflowGraph v2, execution, persistence,
  migration, and test boundaries.
- [Roadmap](roadmap.md) — milestones, release gates, and delivery conventions.
- [Campaign Composer user flow](campaign-composer-user-flow.md) — flagship
  activation, review, adaptation, recovery, and exit evidence.
- [Moderated creator study protocol](../testing/creative-blueprint-creator-study.md)
  — issue #85 recruitment, facilitation, metrics, blocker rules, and evidence
  templates; the protocol is not completed-study evidence.

## Working rules

1. Product and architecture decisions must be recorded here or in a focused
   ADR before implementation depends on them.
2. Every implementation issue must describe a user-visible or architectural
   outcome, acceptance criteria, tests, and explicit non-goals.
3. Each pull request should close one issue or one coherent vertical slice.
4. The workflow board remains usable for visual creators without requiring
   knowledge of model internals or graph programming.
5. Existing `.cxflow.json` files must continue to open through an explicit,
   tested migration path.
