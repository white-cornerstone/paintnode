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
`npm run qa:virtual-creators:prepare`. Validate each completed record with
`npm run qa:virtual-creators:validate -- --validate-observation <path>`, then
validate all eight with `--validate-control-root <path>`. The validators require
the owner decision and fail closed on missing task evidence, lifecycle proof,
instrument drift, invalidating deviations, altered native receipts, unsafe
attestation order, duplicate-selected profile attempts, or reused external AI
task IDs. Retain rejected attempts and select exactly one terminal attempt per
profile for the aggregate.
Never commit generated session plans, prompts, observations, screenshots, or
results.
