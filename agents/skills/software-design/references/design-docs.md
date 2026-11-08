# Design docs

Content filter: **what is the cost of being wrong?** A choice that is cheap
to reverse (a button placement, a page size) is not a design concern and
must not consume review cycles; a choice that is expensive to reverse
(language, storage, service boundary, data model, protocol) is the doc.

What each section must do:

- **Objective and background** read without any outside context: a
  stakeholder who has not talked to the author understands the problem and
  the motivation from the first page, with the numbers that prove it.
- **Goals** are stated as impact on users, the team, or the business, never
  as implementation ("fewer deploy-related outages", not "adopt
  Kubernetes"). **Non-goals** list what a reader would otherwise assume is
  in scope.
- **Scenarios** show the finished system as concrete step sequences when
  the goal alone does not make the behaviour obvious.
- **Interfaces** show the API, CLI, file format, or type signatures that
  consumers will see; UI as rough sketches only.
- **Dependencies** justify the ones that are hard to change later (language,
  storage, hosting); the easily swapped ones get a line.
- **SLOs** are measurable numbers ("p50 < 200 ms"), and **monitoring** says
  how a breach will be noticed.
- **Security** names the threats considered, the attack surface, and the
  trust boundaries (see "Validate at trust boundaries"); write the rationale
  even when the answer is "none apply" so reviewers can disagree.
- **Alternatives** cover only the strong candidates, a few lines each with
  the specific reason they lost.
- **Open issues** each state the problem, the options, a proposed answer,
  and the immediate next step. When resolved, move the entry to **Resolved
  issues** with the decision on top and the original discussion kept.
- **Implementation plan**, when the doc carries one, is its own section
  after the design, so reviewers judge what and why before how; the design
  sections stay at the altitude of interfaces and data flow, with no
  pseudocode or helper names. The plan passes the zero-decision test: a
  fresh session that never saw the conversation can execute it without
  choosing a schema, an API shape, a dependency, or how to handle a new
  edge case. It names the files to create, change, or delete, the change in
  each, the test cases, and phases that each leave the build green. A
  choice still open goes under Open issues, not into a vague step ("update
  the auth service").
- **Governed code** names the files and symbols the design describes, so a
  later reader can check the doc against the code. When they diverge, a
  human decides which one changes.

Diagrams come from an editable source kept next to the doc (`archify` on
this machine), never a photographed whiteboard. Use the repository's
existing design-doc location and headings; the HTML review workflow is
`reviewable-design-doc`, which handles rendering and comment threads, not
content.
