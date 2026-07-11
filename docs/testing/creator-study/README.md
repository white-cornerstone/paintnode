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
- `templates/private-approved-build-record.json` freezes the one literal QA
  build identity approved for sessions. Copy and complete it privately; never
  point setup verification at the blank repository template.
- `templates/private-active-build-decisions.json` is the privately controlled,
  append-only active-decision ledger. Its contiguous history makes a superseded
  record fail even with its matching old app and checkout.
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
5. Privately assign each scheduled date/start/time zone, delivery mode,
   facilitator, observers, technical operator, and accommodation setup. None of
   these assignments belong in repository-safe evidence.

## Approve the study build before the first session

1. From a committed, clean `feature/creative-blueprint` checkout, build the
   repo-native Provider Free app with `npm run qa:native:provider-free`.
2. Rehearse both visible failure checkpoints, editor return, save/reopen, and
   Place in a separate project. Delete that rehearsal project.
3. Copy `templates/private-approved-build-record.json` and
   `templates/private-active-build-decisions.json` to approved restricted
   storage. Copy the literal `gitSha`, `sourceTreeSha`, `sourceStatusSha256`,
   and `executableSha256` values from the app's provenance sidecar. Record the
   fixed Provider Free bundle ID, rehearsal completion time, owner approval
   time, and a non-identifying decision reference.
4. Use strict UTC timestamps with millisecond precision. Rehearsal completion
   must be earlier than owner approval, and approval cannot be in the future.
5. Set initial change control to `kind: "initial"`, null replacement/reason,
   and `comparabilityDecision: "baseline"`. Hash the exact completed record
   bytes with SHA-256, then append generation 1 to the active-decision ledger
   with that fingerprint and the same private decision reference. Keep the
   approved app and its sidecar together and reuse that exact bundle.

The current HEAD does not approve itself. Do not regenerate this record from
`git rev-parse HEAD`, and do not rebuild between sessions: a rebuild has a new
executable identity even when source files appear unchanged.

## Before every session

1. Use a committed, clean checkout at the literal SHA in the current private
   approved-build record. Use the exact preserved app bundle and provenance
   sidecar named by that record; do not build or approve the current HEAD.
2. Rehearse both visible failure checkpoints, editor return, save/reopen, and
   Place with the approved bundle in a separate folder. Delete that rehearsal
   folder. Record this session-preparation rehearsal privately.
3. Create a different, genuinely empty participant project folder outside the
   repository.
4. Locate the built **PaintNode Blueprint QA — Provider Free** app bundle.
5. Run:

   ```sh
   npm run qa:creator-study:setup -- \
     --approved-build-record "ABSOLUTE_PRIVATE_APPROVED_BUILD_RECORD.json" \
     --active-build-decisions "ABSOLUTE_PRIVATE_ACTIVE_BUILD_DECISIONS.json" \
     --app-bundle "ABSOLUTE_PATH_TO_PROVIDER_FREE_APP" \
     --project-dir "ABSOLUTE_EMPTY_PARTICIPANT_PROJECT" \
     --rehearsal-dir "ABSOLUTE_DELETED_REHEARSAL_PROJECT"
   ```

The verifier reads approval from that private record and the privately
controlled active-decision ledger. It checks the clean
checkout, app provenance, actual executable, bundle identity, approved literal
SHA/tree/status/executable fingerprints, canonicalized paths, empty project,
deleted rehearsal path, Product hashes/dimensions, and all three QA controls.
Missing, malformed, in-repository, stale, superseded, future-dated, or
mismatched approval records fail closed. The ledger must contain contiguous,
unique generations and its latest fingerprint/reference must match the supplied
record. Its receipt reports the matched identity, active generation, and
non-sensitive record fingerprint, but omits private paths, approval date,
decision references, change reason, ledger history, storage data, and participant
paths. It does not replace rehearsal or authorization.

## Mid-study build changes

Pause scheduling before changing the approved app. Build the proposed change
from committed clean source, complete a **new rehearsal**, and copy a new
private approved-build record. `kind` must be `mid-study`; record the prior
decision reference, change reason, owner approval, rehearsal completion time,
and a comparability decision of `comparable` or `restart-required`. Preserve the
prior record, hash the exact new record bytes, and append the next contiguous
generation to the active-decision ledger. The replacement reference must equal
the immediately preceding ledger decision. The setup verifier rejects an
incomplete, non-current, or replayed change decision. If the decision is
`restart-required`, do not combine earlier sessions with the new build; record
which sessions are replaced and recruit replacements under the new baseline.
Never overwrite the earlier private approval record.

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
