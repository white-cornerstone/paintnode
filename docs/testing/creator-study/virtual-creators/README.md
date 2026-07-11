# Virtual creator kit

This directory supports the
[virtual creator evaluation](../../creative-blueprint-virtual-creator-evaluation.md).
It contains definitions and schemas only, never completed results.

- `profiles.json` defines eight synthetic behavioral lenses.
- `task-deck.json` pins the exact creator-facing Tasks 1–8 prompts and explicit
  pause points needed for operator checkpoint changes.
- `observation.schema.json` validates synthetic observations and intentionally
  cannot validate as the real creator-study synthesis schema.
- `virtual-aggregate-template.md` separates visible evidence, AI
  interpretation, owner decisions, and hypotheses requiring human validation.

Generate per-session private materials outside the repository with
`npm run qa:virtual-creators:prepare`. Never commit generated session plans,
prompts, observations, screenshots, or results.
