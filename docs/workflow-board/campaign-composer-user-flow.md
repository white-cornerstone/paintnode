# Campaign Composer flagship user flow

Updated: 2026-07-11

Campaign Composer is the Creative Blueprint flagship, not a generic graph demo.
A new workflow opens with Product, optional Subject and Style, Campaign Brief,
Art Direction, Generate Concepts, Choose Campaign Direction, and the three
configured delivery formats already connected.

## Creator path

1. Choose a project and create Campaign Composer.
2. Assign Product. Subject and Style remain optional and explain what they add.
3. Refine the brief or accept a Director draft only after previewing its graph.
4. Generate two or more independent square concepts.
5. Compare candidates with pointer or keyboard (`Left`, `Right`, `Home`, `End`),
   inspect provenance, retry an individual failure, and promote one direction.
6. Optionally open the promoted result in the editor and return a revision.
7. Run downstream. Square is the accepted direction; Portrait 4:5 and Landscape
   16:9 adapt the exact promoted or editor-returned visual.
8. Change an input and review selective preflight before rerunning only stale
   descendants. Unaffected accepted work remains inspectable.
9. Save, quit, reopen, and confirm decisions, revisions, outputs, and recovery
   actions remain available.

## Recovery expectations

- An unpromoted Review blocks formats with a specific promote action.
- One failed candidate or format can be retried without deleting siblings.
- Missing or hash-mismatched accepted material blocks rather than substituting
  another project asset.
- Legacy direct-output and Product-to-Square workflows still open unchanged.

## Exit evidence

The integrated provider-free journey is
`src/lib/workflow/campaignComposerFlagshipAcceptance.test.ts`. It composes guided
binding and Director equivalence, branch failure/retry, promotion, editor return,
all three selected outputs, cache reuse, Product descendant rerun, format
failure/retry, and save/reopen provenance. Focused tests cover migration,
three-shape native QA output, and keyboard candidate navigation. Native
configured-provider execution and a moderated 6–8 creator walkthrough remain
required before the milestone exit gate can be declared met.

The walkthrough must follow the
[moderated creator study protocol](../testing/creative-blueprint-creator-study.md),
including its neutral task prompts, blocker rules, de-identified evidence
templates, and prohibition on fabricated results. Linking the protocol is not
evidence that recruitment or sessions have occurred.
