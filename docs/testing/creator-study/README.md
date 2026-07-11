# Creative Blueprint creator-study operations

This directory turns the moderated protocol into a repeatable study kit. It
does not contain participant evidence. Real sessions remain required before
issue #85 or the MVP milestone can close.

## Privacy boundary

Never complete private templates inside the repository. Copy them to the
approved restricted research location first. Do not use a repository checkout,
Git worktree, issue, pull request, chat, or ordinary project folder as private
study storage.

- `templates/private-*` are blank copy-outside-repository forms. Completed
  copies are private-only.
- `templates/de-identified-recruitment-matrix.csv` may be used for aggregate
  cohort control only after direct identifiers and sensitive detail are
  removed.
- `templates/de-identified-study-decision.md` is the only commit-oriented study
  decision template. It contains aggregate counts, de-identified finding IDs,
  and role sign-offs, not names or raw evidence locations.
- `privacy-fields.json` is the allow/deny contract.

## Before recruitment

1. Copy and complete `private-study-authorization-log.md` outside the repo.
2. Verify access is limited to the owner and named observers.
3. Copy the private screener/recruitment log outside the repo. Maintain any
   participant-code-to-contact mapping there, separately from aggregate data.
4. Confirm the decision owner/date, retention rule, and any exception before
   consent is requested.

## Before every session

1. Build the repo-native provider-free app with
   `npm run qa:native:provider-free`. Close it after rehearsal.
2. Rehearse both visible failure checkpoints, editor return, save/reopen, and
   Place in a separate folder. Delete that rehearsal folder.
3. Create a different, genuinely empty participant project folder outside the
   repository.
4. Locate the built **PaintNode Blueprint QA — Provider Free** app bundle.
5. Run:

   ```sh
   npm run qa:creator-study:setup -- \
     --expected-sha "$(git rev-parse HEAD)" \
     --app-bundle "ABSOLUTE_PATH_TO_PROVIDER_FREE_APP" \
     --project-dir "ABSOLUTE_EMPTY_PARTICIPANT_PROJECT" \
     --rehearsal-dir "ABSOLUTE_DELETED_REHEARSAL_PROJECT"
   ```

The verifier checks the exact SHA, bundle identity, empty project, deleted and
separate rehearsal path, Product hashes/dimensions, and the presence of all
three QA scenario controls. Its receipt deliberately omits local paths. It does
not replace the visible rehearsal or the private authorization gate.

Give [Product A](materials/product-a.png) to the participant for Task 1. Keep
[Product B](materials/product-b.png) hidden until Task 6. Do not copy either
image into the project folder; the participant imports it through PaintNode.
Confirm both hashes against [the material manifest](materials/manifest.json).

## Synthesis

Complete private session records first. Create a de-identified JSON input from
`templates/synthesis-input.blank.json` and validate it against
`synthesis-input.schema.json`. Never include names, contact details, raw quotes,
storage paths, or participant-code mappings.

```sh
npm run qa:creator-study:synthesize -- --input ABSOLUTE_DEIDENTIFIED_INPUT.json
```

The calculator includes `not attempted` in denominators and reports missing
values instead of inventing them. It computes task/full-journey rates,
medians/ranges, cohort counts, severity blockers, thresholds, and a deterministic
recommendation. A `conditional` result does not close issue #85. Only `pass`
sets `milestoneMayClose`, and only when configured-provider evidence, required
sign-offs, complete traceability, thresholds, and blocker rules all pass.

Review the generated aggregate output against the private records, then copy
only approved values into `de-identified-study-decision.md`. Humans remain
responsible for severity decisions, de-identification, exceptions, and sign-off.
