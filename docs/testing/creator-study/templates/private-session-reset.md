# COPY OUTSIDE REPOSITORY — private pre-session and reset checklist

> PRIVATE ONLY. Never complete this file inside the repository.

## Before participant arrival

- [ ] Study authorization gate is complete in approved private storage.
- [ ] Facilitator calibration sign-off matches the current instrument version, SHA-256, and approved Git change reference.
- [ ] Private schedule, roles, delivery mode, and accommodation setup match the recruitment record.
- [ ] Correct SHA, Provider Free bundle identity, and approved-build decision reference recorded.
- [ ] Current active generation and complete private ledger head match the protected study-Mac anchor; only generation and approval ID enter the setup receipt.
- [ ] Setup receipt reports the literal approved identity match.
- [ ] Product A and Product B hashes match the committed manifest.
- [ ] Separate rehearsal completed for both failure checkpoints.
- [ ] Editor return, save/reopen, and Place rehearsed.
- [ ] Rehearsal folder deleted.
- [ ] Participant project folder exists, is genuinely empty, and is outside repo.
- [ ] A new profile was generated with `--fresh-study-session`; its receipt fingerprint differs from the prior participant.
- [ ] Before opening a folder, Project visibly shows no open project/imported assets and Workflow shows no open workflow.
- [ ] Setup verifier passes with `--visible-empty-state-attested`; receipt copied to private session log.
- [ ] Setup receipt reports native app boot observed, one-time setup evidence consumed, and monotonic Keychain anchor recorded.
- [ ] `--resume-study-session` is reserved only for quit/reopen inside this participant session.
- [ ] Recording is off.
- [ ] Product B remains hidden until Task 6.

## After session

- [ ] Recording stopped.
- [ ] Consent withdrawal/deletion action recorded if applicable.
- [ ] Participant project retained/deleted only under the approved evidence rule; app profile is not reused for the next participant.
- [ ] PaintNode closed; `qa:creator-study:finalize-session` reports `dataStoreRemoved: true`; cleanup receipt stored privately.
- [ ] If the build/session ended before setup consumption, `qa:creator-study:abort-session` completed; any launch attempt reports verified `dataStoreRemoved: true`.
- [ ] Raw app-profile handle removed; next fresh session remains blocked until cleanup succeeds.
- [ ] Private notes stored only in approved location.
- [ ] De-identification work item assigned.
- [ ] No private evidence exists in repository, worktree, issue, PR, or chat.
