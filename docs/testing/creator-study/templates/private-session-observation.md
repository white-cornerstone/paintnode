# COPY OUTSIDE REPOSITORY — private session P__

> PRIVATE ONLY. Never complete this file inside the repository. De-identify
> findings separately before they enter aggregate repository evidence.

- Scheduled date:
- Scheduled start time:
- Time zone:
- Delivery mode:
- Assigned facilitator:
- Named session observers:
- Technical session operator:
- Accommodation setup confirmation:
- Accessibility support owner: [private assignment] / not required
- Accessibility support handoff: complete / pending / not required
- Actual start/end time:
- Build Git SHA and QA bundle identity:
- Approved-build decision reference:
- Active build generation and approval ID:
- Setup receipt approved identity match: yes / no
- OS/display scale/window size/input method:
- Eligibility/cohort bucket:
- Participation consent: yes / withdrawn
- Recording consent: yes / no
- Recording status at start: off / on after explicit opt-in
- Approved private storage reference:
- Study owner and named observers:
- Session validity: valid / invalid — reason category (`withdrawn-consent` / `wrong-or-unusable-build` / `provider-invocation` / `prior-exposure` / `facilitator-deviation`; null when valid):
- Private authorization/retention log reference:
- Authorization/retention status verified for this session: yes / no
- Setup receipt profile fingerprint:
- Native app boot observed / setup evidence consumed / monotonic anchor recorded: yes / no
- Lifecycle outcome: finalized / aborted before launch / aborted after launch / not yet complete
- Final cleanup receipt `dataStoreRemoved`: true / false with `dataStoreCreated: false` / not yet complete

| Task | Outcome | Seconds | Neutral probes | Direct assists | Wrong turns | Repeated actions | Error loops | Recovery attempts | SEQ 1–7 | `acceptedWorkPreserved` | Raw evidence/time reference |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | | | | | | | | | | null | |
| 2 | | | | | | | | | | null | |
| 3 | | | | | | | | | | null | |
| 4 | | | | | | | | | | null | |
| 5 | | | | | | | | | | null | |
| 6 | | | | | | | | | | null | |
| 7 | | | | | | | | | | null | |
| 8 | | | | | | | | | | true / false / null | |

For Tasks 1–7, `acceptedWorkPreserved` is always `null`. For Task 8 record
`true` only when accepted work reopens with no data loss or wrong lineage,
`false` when it does not, and `null` only when preservation was not observed.

## Hint, assist, and deviation log

Copy exact values from `facilitator-hints.json`. Assist ordinal is task-local
and increases only for an event with `assistIncrement: 1`.

| Time | Task | Hint ID | Exact hint used | Takeover action ID | Exact takeover action | Assist ordinal | Assist event type | Deviation ID | Session validity effect |
| --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| | | | | | | | | | |

For a hint, use `N/A` in both takeover columns. For a takeover, use `N/A` in
both hint columns and copy the exact ID/action from `takeoverActions`.

## Findings and debrief

For each finding, use participant codes only in `participantIds` and copy one
exact `category` value from `synthesis-input.schema.json`; free-text category
variants are forbidden.

### Private finding handoff

- Finding ID:
- `participantIds`:
- Task:
- `category`:
- Proposed severity: S0 / S1 / S2 / S3 / S4
- `traceable`: true / false
- `resolved`: true / false
- `blocksExit`: true / false
- `exceptionApproved`: true / false
- `exceptionRationaleRecorded`: true / false
- Outcome impact:
- Private observation:
- Artifact/time reference:
- Private exception rationale/decision reference, if applicable:

Set all five decision fields explicitly. `resolved=true` requires
`blocksExit=false`. Exception fields are `false` unless a single non-integrity
S1 has the required cross-functional approval; never record
`exceptionRationaleRecorded=true` without `exceptionApproved=true`.

- Mental model:
- Least clear state/message:
- Release concern:
- Requested change:
- Technical incidents or facilitator deviations:
