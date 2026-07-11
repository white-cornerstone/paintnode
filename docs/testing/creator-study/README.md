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
  append-only active-decision ledger. Setup also pins its complete current head
  (generation, approval ID, decision reference, approval timestamp, and complete
  canonical approved-build decision commitment) in a separate macOS Keychain
  anchor together with a private commitment to the full decision chain, so
  rolling back or rewriting the private files cannot reactivate or falsify an
  older record/build decision.
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

## Approve the study build before the first session

1. From a committed, clean `feature/creative-blueprint` checkout, build the
   deferred-window, study-capable Provider Free app exactly once:

   ```sh
   npm run qa:native:provider-free -- --study-capable --build-only
   ```

   This allocates no profile or lifecycle state. Preserve the resulting app and
   adjacent static provenance sidecar together; neither is rewritten by study
   launch, setup, resume, abort, or finalization.
2. Rehearse both visible failure checkpoints, editor return, save/reopen, and
   Place in a separate project. Delete that rehearsal project.
3. Copy `templates/private-approved-build-record.json` and
   `templates/private-active-build-decisions.json` to approved restricted
   storage. Copy the literal `gitSha`, `sourceTreeSha`, `sourceStatusSha256`,
   and `executableSha256` values from the app's provenance sidecar. Record the
   fixed Provider Free bundle ID, rehearsal completion time, owner approval
   time, a non-identifying decision reference, and a new random lowercase UUIDv4
   `approvalId` unrelated to any private record field.
4. Use strict UTC timestamps with millisecond precision. Rehearsal completion
   must be earlier than owner approval, and approval cannot be in the future.
5. Set initial change control to `kind: "initial"`, null replacement/reason,
   and `comparabilityDecision: "baseline"`. Append generation 1 to the
   active-decision ledger with the same `approvalId`, decision reference, and
   approval timestamp and the SHA-256 commitment of the complete canonical
   approved-build decision record. Setup creates the version-3 protected
   Keychain anchor only at generation 1 and pins that complete private head plus
   the decision-chain commitment. Keep the approved app and its sidecar together
   and reuse that exact bundle.

The private active-decision ledger uses schema version 2. Each entry is a closed
object with exactly `generation`, `approvalId`, `decisionReference`, `approvedAt`,
and `decisionRecordSha256`. The commitment covers the canonical record type,
approved build identity, owner decision, and complete change-control object.
Generate each approval ID independently; never derive it from that commitment or
from the private record, reason, timestamp, or reference.

Generate the canonical commitment only from the completed private record:

```sh
npm run qa:creator-study:decision-commitment -- \
  --approved-build-record /absolute/private/approved-build.json
```

Copy the returned `decisionRecordSha256` into the matching private ledger entry.
The command prints no record fields, paths, timestamps, references, or reasons.

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
3. Verify the assigned facilitator's private calibration sign-off matches the
   current hint instrument version, SHA-256, and approved Git change reference.
4. Create a different, genuinely empty participant project folder outside the
   repository.
5. Start the exact preserved app with a new isolated study profile. This
   generates a cryptographically random
   WebKit data-store identifier that has no access to the generic QA profile,
   rehearsal, or any prior participant profile. The study mechanism requires
   macOS 14 or newer and fails closed on older systems:

   ```sh
   npm run qa:creator-study:launch -- \
     --app-bundle "ABSOLUTE_PATH_TO_PRESERVED_PROVIDER_FREE_APP" \
     --fresh-study-session
   ```

   The launch-existing command performs no Tauri, Vite, Quick Look, or other
   build/configuration step. It returns to this terminal only after current-nonce
   native boot evidence is verified while PaintNode remains open.

6. Before opening any folder, visibly confirm the Project panel has no open
   project or imported assets and no workflow is open. Close the app if either
   is present; do not continue the session.
7. Locate the built **PaintNode Blueprint QA — Provider Free** app bundle and
   run the setup verifier only after making that visible check:

   ```sh
   npm run qa:creator-study:setup -- \
     --approved-build-record "ABSOLUTE_PRIVATE_APPROVED_BUILD_RECORD.json" \
     --active-build-decisions "ABSOLUTE_PRIVATE_ACTIVE_BUILD_DECISIONS.json" \
     --app-bundle "ABSOLUTE_PATH_TO_PROVIDER_FREE_APP" \
     --project-dir "ABSOLUTE_EMPTY_PARTICIPANT_PROJECT" \
     --rehearsal-dir "ABSOLUTE_DELETED_REHEARSAL_PROJECT" \
     --visible-empty-state-attested
   ```

8. To test quit/reopen within this same participant session, relaunch with the
   same isolated profile:

   ```sh
   npm run qa:creator-study:launch -- \
     --app-bundle "ABSOLUTE_PATH_TO_PRESERVED_PROVIDER_FREE_APP" \
     --resume-study-session
   ```

   `--resume-study-session` must never start a new participant. The next
   participant always begins again at step 5 with `--fresh-study-session`.

The verifier reads approval from the private approved-build record and
active-decision ledger. It checks the clean checkout, app provenance and actual
executable, approved literal SHA/tree/status/executable fingerprints,
canonicalized paths, empty project, deleted rehearsal path, a freshly generated
isolated study profile, Product hashes/dimensions, all three QA controls, and the
operator's visible-empty-state attestation. Generic or resumed profiles and
missing, malformed, duplicate-key, in-repository, stale, superseded,
future-dated, or mismatched approval records fail closed.

The ledger must contain contiguous unique generations with strictly increasing
approval timestamps, and its latest canonical decision commitment must match
the supplied record. The separate approved-build Keychain anchor must match the
complete current head or advance by exactly one generation from an exact
protected previous-head and chain-prefix match. Advancement is serialized under
an exclusive process lock and re-read after writing. Legacy version-1 or
version-2 anchor payloads fail closed. Use the same approved study Mac for the
whole study; do not delete, reset, export, or restore the
`com.paintnode.creator-study.active-build` item. The lifecycle-consumption
Keychain marker is separate and create-once.

The receipt reports the matched approved identity, active generation, random
non-derived approval ID, one-way profile fingerprint, native boot consumption,
and visible-empty attestation. It omits raw profile identifiers, private anchor
commitments, approval dates/references, paths, change reasons, ledger history,
and storage data. It does not replace rehearsal or private authorization.

Static build provenance never contains participant/session state. A separate
create-only private launch binding records the canonical preserved bundle,
static-sidecar hash, executable hash, build-identity hash, and one-way profile
fingerprint. Native boot evidence repeats the build-identity and current nonce
fingerprints. Setup requires all three identities to match and rechecks the
executable; resume and cleanup resolve the same preserved executable through that
binding.

The setup receipt is single-use. It reports `appBootObserved: true` only after
the Provider Free executable has actually created the isolated window, and
`setupEvidenceConsumed: true` when that boot generation is consumed. A
`--build-only` bundle, missing boot marker, stale marker, or second setup attempt
for the same generation fails closed; the manual visible-empty attestation is
recorded separately and is never treated as machine-observed UI evidence.
Consumption is also recorded create-once in the macOS login Keychain as a
monotonic single-Mac anchor. Restoring the ignored state and boot-evidence files
cannot restore that marker or make the same profile consumable again. Do not
delete those Keychain markers during the study.

`--study-capable --build-only` creates the one deferred-window bundle and static
provenance without allocating a profile, nonce, state file, launch binding, or
Keychain marker. In other words, build-only does not allocate live session
state. The bundle becomes session-capable only when started through
`qa:creator-study:launch`; build-only by itself cannot pass participant setup.

## After every session

After Task 8 save/reopen is complete, close PaintNode and run:

```sh
npm run qa:creator-study:finalize-session
```

This launches the same preserved and re-verified Provider Free executable from
the create-only launch binding in cleanup-only mode,
removes the session's persistent macOS WebKit data store, verifies one-time
native cleanup evidence, deletes the local raw profile handle, and prints a
path-free receipt containing only its fingerprint and `dataStoreRemoved: true`.
Copy that receipt to the private session log. A new `--fresh-study-session`
fails closed until the prior session is finalized. The app profile is transient
operational state and is never retained as research evidence; apply approved
retention rules to the participant project/evidence instead.

If the build fails, the first app launch fails, PaintNode is closed before setup,
or the session is abandoned before setup evidence is consumed, run:

```sh
npm run qa:creator-study:abort-session
```

An abort before any launch attempt releases the unused handle without claiming
a data store existed. Once launch was attempted, abort uses the same native
WebKit removal and verified cleanup evidence as finalization. Failure retains
the raw handle and blocks the next fresh session; manual deletion is unsupported.

## Mid-study build changes

Pause scheduling before changing the approved app. Build the proposed change
from committed clean source, complete a **new rehearsal**, and copy a new
private approved-build record. `kind` must be `mid-study`; record the prior
decision reference, change reason, owner approval, rehearsal completion time,
and a comparability decision of `comparable` or `restart-required`. Create a new
random `approvalId`, preserve the prior record, and append the next contiguous
generation with its canonical decision commitment to the active-decision
ledger. The approval time must increase, the new rehearsal must follow the
preceding approval, and the replacement reference must identify the immediately
preceding decision. Never overwrite the earlier private approval record.

The approved-build Keychain anchor must advance atomically to that exact head.
If comparability is `restart-required`, do not combine earlier sessions with the
new build; record which sessions are replaced and recruit replacements under the
new baseline. The Provider Free lifecycle remains per participant: abort or
finalize the current isolated profile before starting another fresh session.

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
