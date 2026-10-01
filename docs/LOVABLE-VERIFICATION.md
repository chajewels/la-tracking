<!-- Moved VERBATIM from CLAUDE.md on 2026-09-24 to bring it under the
     Claude Code load limit. CLAUDE.md keeps every rule from these sections
     as a rules block with a pointer here; this file keeps the full text.
     Read it when a task touches this area. -->

    THE THIRD OCCURRENCE IS ALSO THE MODEL ANSWER: Lovable refused to fake it —
    "I could not run either of these two, and I'm not going to report a pass on
    other evidence" — then reported what it COULD observe (both endpoints reach
    their auth gate and return 401, not 404; both plans' lines carry a variant
    with photos and a null stored image, the exact case the resolver fills at
    read time) and handed the 200-with-photo confirmation to the acceptance run.
    That is the behaviour the rule wants. The defect was in the ASK, not the
    answer.


## Rules moved from CLAUDE.md (2026-10-02, verbatim)

Moved out of CLAUDE.md on 2026-10-02 to keep it under 100 KB. Text is verbatim (only the 2-space CLAUDE.md indent removed); CLAUDE.md keeps the one-line rules and a pointer here.

### AN ASSERTION NOBODY CAN SATISFY IS WORSE THAN NO ASSERTION

- AN ASSERTION NOBODY CAN SATISFY IS WORSE THAN NO ASSERTION (added 2026-09-15,
  THIRD occurrence). A check that cannot be run gets substituted, waved
  through, or reported as a pass on different evidence — and that is worse than
  asking for something weaker and true. Three times now a message has asked
  Lovable for proof it had no way to produce: a preview render needing
  LOVABLE_API_KEY (2026-09-14, answered 401); an end-to-end customer flow
  needing a signed-in session, a cart and an address (2026-09-15); and message
  K's step 3(d), "GET /website/layaway and the portal must answer 200 not 400"
  (2026-09-15), which needs the website API key and a real customer session.
  Before writing a verification step, ask what the agent can actually observe
  with the access it has, and ask for THAT — the deployed function body plus
  its version and timestamp, not a synthesised user journey. Where the real
  proof needs a human in a browser, say so in the message and assign it to the
  owner's own acceptance run instead of dressing it up as an automated check.
  The model answer (Lovable refusing to fake a check, 2026-09-15):
  docs/LOVABLE-VERIFICATION.md (moved verbatim 2026-09-24).
