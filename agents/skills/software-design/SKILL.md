---
name: software-design
description: >
  Load before shaping a module boundary, public interface, error-handling
  policy, or data model; before a refactoring larger than a rename; when a
  decision outlives a commit (ADR); and before writing a design doc. Design
  norms (deep modules, dependency direction, invariants, one error policy,
  when to abstract), the TS/JS shape (functional core, when a class earns
  its place, minimal capability types), the refactoring procedure, what a
  design doc must contain, and the ADR template and placement rule.
---

# software-design

Ponytail decides how much to build; this skill decides the shape of what gets
built. Review skills (`github-pr-review`, OMP `reviewer`) check the result
afterwards; apply this before and while writing. Harness and repository rules
take precedence over the norms below.

## Discover the repository's shape first

Read the neighbouring module, its tests, and any architecture note (README,
`docs/`, ADRs) before designing. Existing layering, error style, naming, and
directory layout override this skill; a second convention beside an existing
one is a defect, not a design choice. When the existing convention is the
problem, change it in its own commit with the reason in the body, or record
an ADR; never introduce the new style piecemeal.

Before changing code that looks wrong, find out why it is that way: its
Why-not comment, then `git blame` or `git log -L` to the commit that
introduced it and that commit's body, then the linked PR or issue. "Nothing
found" is a finding; report it instead of inventing a reason. Before
proposing the change, list what must be preserved, what changes, what stays
untouched, and which risks remain unverified.

## Design norms

Each norm ends with the question to ask of the code you are about to write.

**Deep modules.** An interface should be small relative to the functionality
it hides. A module whose interface is as large as its implementation
(pass-through methods, one-line wrappers, a "manager" forwarding to one
callee) adds a layer without hiding anything; inline it. *Does the caller
need to know less than before?*

**Thirty-second trace.** A new reader should be able to say where a value
comes from and what can change it within thirty seconds; if not, there is a
layer or a piece of state too many, and it gets removed rather than
documented. *Can a reader answer "where does X come from, what changes X"
for each value or piece of state they must trace to follow this change?*

**Dependency direction (the Clean Architecture rule).** Source dependencies
point inward only: entities and use cases know nothing of HTTP, DB,
filesystem, clock, UI, or framework; adapters at the edge depend on the
core, never the reverse. Where the core must call outward (a repository, a
gateway), the core owns the interface and the edge implements it. Crossing
a boundary passes simple data, not framework objects. Do not add the four
named layers to a small program: the rule is the direction, not the layer
count. *Can the core be exercised without network, disk, or a real clock,
and does any core file import an edge?*

**Validate at trust boundaries, trust inside.** User input, third-party
responses, environment, and files are untrusted; parse them into typed values
once at the edge and let internal code assume them valid. Re-validating
between internal functions hides which layer owns correctness. *Where does
this value cross a trust boundary, and is it parsed there exactly once?*

**Invariants in one place.** State what must always hold (non-empty cart,
unique key, ordered range) and enforce it where the value is created
(constructor, factory, DB constraint), not in every consumer. Prefer types
that make the illegal state unrepresentable: a sum type over a flag plus a
nullable, a parsed `Email` over a `string`. *Which single site guarantees
this invariant, and can a caller bypass it?*

**One error policy.** Follow the codebase's existing one; if there is none,
pick one and apply it everywhere. Expected outcomes (not found, invalid
input, conflict) are return values or a documented error type; programmer
errors and infrastructure failures fail fast. Define errors out of existence
when a total definition is safe (deleting a missing row is a no-op, an
out-of-range slice is empty). Add context where an error crosses a layer;
never swallow it, never catch-log-continue on the path that owns the data.
*Can the caller tell an expected outcome from a bug, and does any path drop
the error?*

**Abstract at the third concrete case, or at a boundary that must swap now.**
An interface with one implementation, a factory for one product, a config
knob for a value that never changes, a base class "for later": all
speculative generality, all deleted. Introduce the abstraction when three
call sites share the same shape, or when the seam is needed today for a
test double or a real second implementation. *What concrete second case
exists right now?*

**Observable behaviour is the contract (Hyrum's law).** Anything a consumer
can observe (ordering, timing, error text, undocumented fields) will be
depended on. Expose less; extend by addition (optional fields, new
functions) rather than modification; keep naming and list/filter shapes
consistent with the neighbours. *What am I exposing that I do not want to
support?*

**Cohesion by change axis.** Things that change together live together; a
module you describe with "and" is two modules. Shotgun surgery (one change
touching many files) and divergent change (one file changed for unrelated
reasons) are the two symptoms. *If requirement X changes, how many files
move?*

**Do one thing, compose (UNIX philosophy).** A program, command, or function
has one job and stops there; combine small ones instead of growing one.
Tools speak plain text or one structured format (JSON lines) on stdin and
stdout so they chain; diagnostics go to stderr; success is silent and
failure is a non-zero exit. Prefer a filter over a mode flag, and a pipeline
of existing tools over a new binary. *Could this be two things joined by a
pipe or a call, and does its output feed the next tool unchanged?*

**Facts, not derived state.** Persist and pass facts; compute views. Cached
or duplicated derived data needs an owner and an invalidation rule, so leave
it out until measured. Prefer a schema constraint to application code for
uniqueness, non-null, and referential integrity. *Which value is the source
of truth for this?*

**Time and concurrency are inputs.** Inject the clock and randomness. A
check-then-act sequence on shared state is a race; claim atomically (unique
constraint, compare-and-swap, `INSERT ... ON CONFLICT`). Any remote call has
three outcomes, success, failure, and unknown; record the intent before
calling out so a timeout after the effect applied can be resolved. *What
happens when two of these run at once, or the call times out after the
effect applied?*

**Re-runs converge; writers do not share.** A state-mutating step must reach
the same end state when it runs twice or after the previous run crashed at
any point: read the current state, compare it with the goal, apply only the
difference. Anything a run leaves behind (lock, temp file, half-written
record, claimed job) must be recognisable as stale by the next run; write to
a temp path and rename into place. Before adding a lock, ask whether the
concurrent actors need one shared write target at all: give each its own
file, key, or branch and merge when reading. Serialize (lock, single writer,
compare-and-swap) only when one shared target is a real invariant;
instructions and conventions are not concurrency control. *What happens if
this runs twice, crashed halfway, or two actors write at once?*

## TypeScript and JavaScript

Before writing or changing TS/JS code, read
[TypeScript and JavaScript](references/typescript-javascript.md) for the
language-specific design norms and lint limits. Runtime and verification
guidance remains in `efficient-ts-js`.

## Gate before writing

Answer each in one line; a blank answer means the design is not ready.

1. Which existing module does this belong to, and why not there?
2. What does the caller need to know (interface), and what is hidden (depth)?
3. Where does untrusted data enter, and what type does it become?
4. What must always hold, and which site enforces it?
5. What does failure look like to the caller?

## Sketch the shape before filling it in

For a new public interface, or a boundary with no precedent in the
repository:

1. Write the call site first, the few lines a caller will write; then the
   types and signatures, with bodies that throw "not implemented". The
   sketch is the contract.
2. When the boundary is expensive to reverse and more than one shape is
   viable, sketch at least two structurally different ones (one function vs
   a stateful type, push vs pull), not two variants of one. Choose with the
   gate questions above, except when the shapes differ in what a user or
   caller can observe (layout, latency, interaction): then build a quick,
   throwaway prototype of each and choose on recorded output (screenshot,
   timing, read-back value). Record why the other lost: in the ADR's
   Alternatives when the decision warrants one, otherwise in the commit body.
   Otherwise sketch the neighbouring convention once.
3. While filling in the bodies, scrap the sketch and redesign when any of
   these appears: the same workaround in unrelated call sites; an `any`, a
   forced cast, or an argument the sketch did not have; a lock on state the
   sketch said was not shared; callers that must know the internal
   initialisation order; the same mismatch in two independent places. One
   occurrence is friction, not a reason to scrap.

## Refactoring

Refactor when the current shape resists the change you need (make the change
easy, then make the easy change), or on green after a feature lands.
Behaviour change and refactoring never share a commit.

Before refactoring, read [Refactoring](references/refactoring.md) for the
required sequence, verification and commit discipline, and smell-to-move table.

## Design docs

A design doc is the pre-implementation counterpart of an ADR: an ADR
records one decision, a design doc lays out a project so reviewers can find
the wrong decision before code exists. Write one when two or more hold:
several people implement it; more than about three months of work; it runs
in production for years; goals or requirements are ambiguous; a
catastrophic risk (security, data loss, legal) can be prevented at design
time. One "yes" is worth a one-pager; none means skip it.

Before drafting or reviewing a design doc, read
[Design docs](references/design-docs.md) for the content filter, required
sections, implementation-readiness criteria, and repository conventions.

## ADRs

Write an ADR for a decision that outlives a commit and is expensive to
reverse: a dependency or framework, a data model, a service or module
boundary, a protocol or API style, build or hosting. Local code choices go
in the commit body (Why) or a code comment (Why-not), not in an ADR.

Before creating or superseding an ADR, read [ADRs](references/adrs.md) for
repository placement, numbering, the template, and accepted-decision handling.

Sources: Ousterhout, *A Philosophy of Software Design*; Martin, *Clean
Architecture* (dependency rule); Raymond, *The Art of Unix Programming*
(do one thing, composition, silence on success); Fowler, *Refactoring*;
Feathers, *Working Effectively with Legacy Code*; Nygard's ADR format;
Lynch, "How to Write an Effective Software Design Document"
(refactoringenglish.com); addyosmani/agent-skills
`api-and-interface-design` and `documentation-and-adrs`; poteto's pstack
(`cursor/plugins`: `architect`, `why`, `principle-make-operations-idempotent`,
`principle-separate-before-serializing-shared-state`,
`principle-minimize-reader-load`); google/elephant-goldfish-model
(implementation-readiness and zoom-out standards, drift report).
