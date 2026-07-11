# Creative Blueprint study decision

> DE-IDENTIFIED REPOSITORY EVIDENCE ONLY. Do not add names, contacts, storage
> paths or references, raw notes, recordings, participant mappings,
> accommodation details, or identifying quotes.

- Study date range:
- Approved build SHA(s) and reason for any change:
- Recruited / valid / invalid / replacement counts:
- Aggregate cohort mix:
- Recording/identifiable-note deletion status: pending / complete / exception approved privately
- Configured-provider evidence reference:

## Executive result

- Recommendation: pass / conditional / block / insufficient evidence
- Valid sessions: __ of planned 6–8
- Full-journey unaided: __/__ (__%)
- Full-journey assisted or unaided: __/__ (__%)
- Data-loss or wrong-lineage events:
- S0 / S1 / S2 / S3 / S4 counts:
- Thresholds met/missed:
- Issue #85 may close: yes / no

## Task metrics

| Task | Unaided count/denominator | Assisted | Failed/not attempted | Median seconds (range) | Median SEQ (range) | Participants with finding |
| --- | --- | ---: | ---: | --- | --- | ---: |
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |
| 4 | | | | | | |
| 5 | | | | | | |
| 6 | | | | | | |
| 7 | | | | | | |
| 8 | | | | | | |

## De-identified participant burden

| Participant code | Neutral probes | Direct assists | Wrong turns | Repeated actions | Error loops | Recovery attempts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| | | | | | | |

## Prioritized de-identified findings

Use participant codes only in `participantIds`. Copy `category` from the closed
enum in `synthesis-input.schema.json`; never add private scheduling metadata or
raw evidence.

| ID | `participantIds` | `category` | Frequency | Severity | `traceable` | `resolved` | `blocksExit` | `exceptionApproved` | `exceptionRationaleRecorded` | Paraphrased evidence | Owner role | Decision/fix | Re-test reference |
| --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | | | | | | |

Every boolean is required. `resolved=true` requires `blocksExit=false`.
Exception fields remain `false` unless a single non-integrity S1 has the
required cross-functional approval and recorded rationale.

## Decision audit

- Blocker rules triggered:
- Approved S1 exceptions and cross-functional rationale:
- Accessibility decision:
- Required fixes before exit:
- Deferred findings and non-blocking rationale:
- Follow-up/re-test plan:
- Product role sign-off:
- Design role sign-off:
- Engineering role sign-off:
- Accessibility role sign-off:

`conditional` never closes issue #85. `pass` requires 6–8 valid real sessions,
complete traceability, cohort coverage or a documented recruitment decision,
all study thresholds, no unresolved blocker, configured-provider evidence, and
all required role sign-offs.
