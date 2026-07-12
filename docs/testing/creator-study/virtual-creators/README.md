# Normal-app virtual creator kit

This directory supports the
[normal-app virtual creator evaluation](../../creative-blueprint-virtual-creator-evaluation.md).
It contains definitions and schemas only, never completed results.

- `profiles.json` defines eight synthetic behavioral lenses.
- `task-deck.json` defines normal public-user tasks using real providers. It
  contains no deterministic failures or Provider Free scenario controls.
- `observation.schema.json` validates schema-v2 normal-app observations and
  cannot validate as human creator-study evidence.
- `virtual-aggregate-template.md` separates visible evidence, AI
  interpretation, owner decisions, and human-validation hypotheses.

Generate private packets outside the repository with
`npm run qa:virtual-creators:prepare`. Validate records with
`npm run qa:virtual-creators:validate`. Retain rejected attempts, retry them in
fresh tasks, and select exactly one owner-accepted attempt for each V01–V08 profile.
Never commit generated prompts, observations, screenshots, projects, or
results.
