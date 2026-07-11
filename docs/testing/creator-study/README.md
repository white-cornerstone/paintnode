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
- `facilitator-hints.json` is the versioned, participant-hidden hint, takeover,
  assist, and deviation instrument; its approved text is repository-safe.
  `facilitator-hints.sha256` pins its exact bytes. Participant-linked delivered
  intervention records remain private-only.

## Before recruitment

1. Copy and complete `private-study-authorization-log.md` outside the repo.
2. Verify access is limited to the owner and named observers.
3. Copy the private screener/recruitment log outside the repo. Maintain any
   participant-code-to-contact mapping there, separately from aggregate data.
4. Confirm the decision owner/date, retention rule, and any exception before
   consent is requested.
5. Privately assign each scheduled date/start/time zone, delivery mode,
   facilitator, observers, technical operator, and accommodation setup. None of
   these assignments belong in repository-safe evidence.
6. Verify `facilitator-hints.json` against `facilitator-hints.sha256`. Record its
   version, SHA-256, and approved Git SHA/change reference in the private sign-off.
7. Calibrate and rehearse every facilitator against that exact instrument before
   participant 1 and after every approved instrument change. Any instrument edit
   requires a new committed hash, approved Git change reference, and renewed
   sign-off even if the integer version is unchanged.

## Before every session

1. From a committed, clean checkout, build the repo-native provider-free app
   with `npm run qa:native:provider-free`. Close it after rehearsal. The build
   writes a provenance sidecar beside the app containing the source SHA/tree
   and actual executable fingerprint; keep the app and sidecar together.
2. Rehearse both visible failure checkpoints, editor return, save/reopen, and
   Place in a separate folder. Delete that rehearsal folder.
3. Verify the assigned facilitator's private calibration sign-off matches the
   current hint instrument version, SHA-256, and approved Git change reference.
4. Create a different, genuinely empty participant project folder outside the
   repository.
5. Locate the built **PaintNode Blueprint QA — Provider Free** app bundle.
6. Run:

   ```sh
   npm run qa:creator-study:setup -- \
     --expected-sha "$(git rev-parse HEAD)" \
     --app-bundle "ABSOLUTE_PATH_TO_PROVIDER_FREE_APP" \
     --project-dir "ABSOLUTE_EMPTY_PARTICIPANT_PROJECT" \
     --rehearsal-dir "ABSOLUTE_DELETED_REHEARSAL_PROJECT"
   ```

The verifier checks a clean source tree, the exact SHA/tree recorded by the
actual build, bundle identity, executable fingerprint, canonicalized paths,
empty project, deleted and separate rehearsal path, Product hashes/dimensions,
and all three QA scenario controls. Stale bundles, modified executables, dirty
source, broken symlinks, and symlink aliases into the repository fail closed.
Its receipt deliberately omits local paths. It does not replace the visible
rehearsal or the private authorization gate.

Give [Product A](materials/product-a.png) to the participant for Task 1. Keep
[Product B](materials/product-b.png) hidden until Task 6. Do not copy either
image into the project folder; the participant imports it through PaintNode.
Confirm both hashes against [the material manifest](materials/manifest.json).

## Synthesis

Complete private session records first. Create a de-identified JSON input from
`templates/synthesis-input.blank.json` and validate it against
`synthesis-input.schema.json`. Never include names, contact details, raw quotes,
storage paths, or participant-code mappings.

The current input contract is schema version 2. Its closed
`recruitmentExceptions` object has separate `cohortMix` and
`keyboardOrAccessibilityCoverage` records. An exception is complete only when
`approved=true`, `rationaleRecorded=true`, and `decisionReference` is a
de-identified `CB-DEC-N` ID. Otherwise keep the record at `approved=false`,
`rationaleRecorded=false`, and `decisionReference=null`. Each exception applies
only to its own missing requirement; one can never waive the other. When both
are approved, their `decisionReference` values must be distinct even if both
rows live in the same overall study decision document.

No real participant input exists under version 1, so the calculator rejects
version 1 instead of guessing how its generic flag should split. Start every
real synthesis from the committed version-2 blank template.

Record `acceptedWorkPreserved=null` for Tasks 1–7. For Task 8 use `true` only
when accepted work reopens with no data loss or wrong lineage, `false` when it
does not, and `null` only when preservation was not observed. Every finding must
carry the complete closed handoff: `participantIds`, `category`, `traceable`,
`resolved`, `blocksExit`, `exceptionApproved`, and
`exceptionRationaleRecorded`. Category values come only from the schema enum.

```sh
npm run qa:creator-study:synthesize -- --input ABSOLUTE_DEIDENTIFIED_INPUT.json
```

The calculator includes `not attempted` in denominators and reports missing
values instead of inventing them. It computes task/full-journey rates,
medians/ranges, cohort counts, severity blockers, thresholds, and a deterministic
recommendation. A `conditional` result does not close issue #85. Only `pass`
sets `milestoneMayClose`, and only when configured-provider evidence, required
sign-offs, complete traceability, thresholds, blocker rules, and both
recruitment requirements or their own complete approved exceptions all pass.

Review the generated aggregate output against the private records, then copy
only approved values into `de-identified-study-decision.md`. Humans remain
responsible for severity decisions, de-identification, exceptions, and sign-off.

Participant records use sequential codes `P01`–`P99`. Invalid sessions and
replacements keep their own records and codes, so eight valid sessions may
coexist with additional invalid/replacement records. Only the valid-session
count is constrained to 6–8. Finding categories come from the closed enum in
`scripts/creator-study-contract.mjs`; finding IDs must be unique and every
finding must reference at least one participant code.
