---
name: test-design
description: >
  Load before writing, changing, or deleting tests, before adding a mock or
  test helper, before the first edit of any change to code, scripts, hooks,
  or config, and when deciding whether a change needs a test at all. Which
  tests earn their place, the viewpoint walk that finds missing cases, how
  deep to test each kind of code, the behaviour list (opened by a security
  triage) written before implementing, the rules that must hold in any
  order of operations, what to assert, the test-double ladder,
  characterisation tests before refactoring, property-based, stateful, and
  differential tests, model checking, the blast radius of a diff (what it can
  break outside itself), and the mutation check.
---

# test-design

Tests carry the What: each one pins an observable contract a consumer relies
on. A test that cannot fail on a plausible bug is maintenance without
protection; a missing test on a real boundary is a bug waiting for a
reviewer. This skill decides which tests to write and how. The repository's
runner, layout, naming, and the size of neighbouring tests decide the rest:
read two neighbouring test files before writing one.

## Which tests a change needs

| Change | Test |
| --- | --- |
| Bug fix | One reproduction that fails before the fix and passes after. Check sibling callers of the fixed function; if they had the same bug, the reproduction covers them or gets a row. Each other viewpoint marked *test* in the walk below gets a test too. |
| New behaviour | One test per observable contract: the happy path, each boundary (empty, one, max, off-by-one), each error the caller must handle, each viewpoint marked *test* in the walk below. |
| Refactoring | No new tests. If the code has none, characterisation tests first (below), then refactor, then change behaviour in a separate commit. |
| Public interface change | Existing tests updated to the new contract; a migration-path test only if consumers can hit both shapes at once. |
| Script, hook, skill, config | Run it against controlled input and assert output, exit code, or side effect. Never assert that the source contains a line. |
| Trivial forwarding, constants, getters, wiring | None. Assert the first consumer-visible result that depends on them instead. |
| Prose for humans | None. |

Scratch checks (a throwaway script proving a change) need not be kept. Keep
a test when the repository keeps tests for that kind of change, sized like
its neighbours.

## Walk the viewpoints before choosing tests

A missed viewpoint is the bug no test, review, or mutation check catches:
when nobody thought of a case, the code has no branch for it either, so
reading or mutating the code reveals nothing. Derive viewpoints from the
contract (ticket, spec, the inputs and environments a caller can actually
produce), not from the branches the code already has.

For new behaviour and bug fixes, first place the code in the depth table
after the viewpoints, then walk every row and mark it *test*, *covered
elsewhere* (naming the upstream or existing test that covers it), *not
applicable* (with a one-line reason), or *out of scope*. A row that applies
but sits outside the code's depth is *covered elsewhere*, never *not
applicable*; if no test covers it yet, it is *test*, written at the layer
whose depth includes it:

| Viewpoint | Ask |
| --- | --- |
| Input domain | Equivalence classes and their boundaries; null, empty, whitespace, very long, non-ASCII, negative, duplicate, unsorted, malformed. |
| State | Each state the target can be in when called: first run, already done, half-finished after a failure. Invalid transitions. The same operation twice (double submit, retry, re-running an idempotent script). |
| Combination | Conditions that change the outcome together: a decision table when two or more flags or inputs interact. |
| Time | Timezone and DST, month end and leap day, expiry exactly at the boundary, a clock that moved backwards. |
| Dependencies | Each way a dependency fails: missing, timeout, partial or out-of-order response, permission denied, rate limit. |
| Concurrency | Two callers at once, a write racing a read, re-entry. Check-then-act: a value read when the user confirms (stock, balance, permission) is changed by someone else before the commit. |
| Authority | Both directions for every actor the feature serves, logged out and the lowest role included: allowed actors still succeed, the rest are refused (unauthenticated, unauthorised, another tenant's or user's resource). After an auth or middleware change, run each feature it now covers as a logged-out visitor. Escaped once: an auth change made a feature meant for logged-out visitors require login, and no test ran logged out. |
| Environment | OS and version differences, a tool missing from PATH, absent or old-format config and data. |
| Scale | Zero, one, many, more than fits in memory or on one page. |
| Sibling paths | Other callers and entry points that reach the changed code. |

How deep the walk goes depends on the kind of code:

| Code | Depth |
| --- | --- |
| Domain logic, algorithms, parsers, validation | Every applicable row, thoroughly: boundaries, decision tables, state transitions. Bugs here are cheap to test and spread downstream. |
| Orchestration (controllers, use cases, command entry points, glue calling several parts) | One representative happy path, plus failures that appear only when the parts are combined (a later step fails after an earlier one succeeded). Do not re-test value ranges the logic's own tests cover. |
| Presentation (CLI output, formatting) | Structure only (headers, column order, row count); values belong to the tests of the code that computes them. Move input validation into a pure function and test it there. |
| Trivial code | None (see the table above). |
| Logic tangled with many dependencies | Split it first (pure logic out, a thin shell around the I/O), then test each part at its depth. Needing many mocks to reach one rule is the signal. |

When a bug escapes, add the viewpoint that would have caught it to the
viewpoint table in the same change as the fix: a new row, or a sharper
question in an existing one. Phrase it generically; this file is public.
The viewpoint table is the record of what has been missed before.

## Write the behaviour list before implementing

The walk's result is for a human to check before any code exists, where a
wrong or missing behaviour is cheapest to catch. For every change to code,
scripts, hooks, or config (prose has no behaviour), write two lists before
the first edit. A plan holds them when there is one; otherwise show them in
the reply, then proceed.

- **Behaviours to confirm**: one item per behaviour, each naming the test
  that will confirm it. For a refactoring, the behaviours that must stay
  unchanged.
- **Behaviours deliberately not confirmed**: each with one reason from this
  vocabulary: would be a change detector or a copy of the implementation;
  trivial; left to an integration test or a manual check; covered by tests
  of upstream logic; covered by an existing test; out of scope for this
  change. Viewpoint rows marked *covered elsewhere*, *not applicable*, or
  *out of scope* go here.

When the change holds state that several actors or steps touch (stock,
money, balances, quotas, permissions, a multi-step flow), put first in
**Behaviours to confirm** the rules that must hold after any sequence of
operations, by anyone, in any order: 「売れたチケットの枚数は、最初の在庫数を
超えない。」 Each rule names its source (ticket, spec, the user's words). A
rule read off the implementation is no oracle: code and tests written from
the same assumptions miss the same cases and pass together. The rules are
what the user checks; the cases that exercise them come from a generator
(stateful property tests, below), not from the agent that wrote the code.

Open the lists with a one-line security triage: does the change touch
authentication or authorization, secrets, untrusted input, file or command
execution, outbound requests, or CI/deploy privileges? If not, say so; the
triage adds no test and no audit. If it does, answer `software-design`'s
security gate, and for each touched boundary list the refused case beside
the allowed one: the Authority row's two directions; a hostile input (a
path that climbs out of its root, shell metacharacters, an oversized value)
rejected or kept inert; a secret that never reaches logs, output, or argv;
an outbound request to an unintended destination refused. The allowed case
keeps its own item, so a change that refuses everyone still fails a test.

Repeat both lists in the final report and mark any item that changed during
implementation.

Write each item so that someone who knows the domain but not the code can
judge it. Test names and comments follow the same rules.

- One sentence stating what the user or caller does and what must then
  happen. One behaviour per item; split an item that carries several
  conditions.
- The user's words, not the code's: no variable name, internal data
  structure, or test term as subject or predicate. Name code, if needed, in
  parentheses after the sentence. Define a coined term or abbreviation at
  first use.
- In Japanese, end on a verb, not a noun or `=true`, and keep the subject
  and particles.

Not `auth middleware coverage for public routes`, but
「ログアウトしている利用者が公開ページを開くと、ログインを求められずに表示される。」

## Name the break before writing the body

State the production change that would make this test fail, then classify
it:

- **A bug** (wrong branch, missing side effect, wrong argument, off-by-one,
  missing validation of empty, zero, nil, unauthorised, or malformed input):
  write the test.
- **Only an intentional decision** (a constant's value, message wording,
  private structure, a call order nothing depends on): a change detector.
  Test the behaviour that depends on the decision instead; not
  `MAX_RETRIES == 5` but "the sixth attempt never happens".
- **Nothing**: redesign around an observable behaviour or drop the test.

## What to assert

Assert what a consumer observes: return value, persisted state, emitted
event, response body, exit code. Derive the expected value by hand, as a
literal or a hand-checked fixture, never by calling the code under test or
its helpers; a mirror assertion passes whatever the code does. Table-driven
tests with literal `want` columns are the preferred shape for several inputs
of one behaviour.

For a bug fix, the expected value is the intended behaviour, not what the
buggy code returns today (two notifications sent: expect one). Never weaken
an existing assertion (`toBe(1)` to `toBeGreaterThanOrEqual(1)`) to make a
change pass; change it only when the intended behaviour itself changed, and
say why in the commit body.

Test your contract at your boundary, not the framework's mechanics: the route
you register, the query you emit, the payload you produce. Asserting that the
router invokes a registered handler is the router's test. When a dependency's
behaviour genuinely surprised you, one narrow characterisation test naming
the assumption is enough.

One behaviour per test, named by behaviour, condition, and outcome
(`rejects expired token`, `returns empty list when no orders`), not by the
method it calls. Arrange, act, assert. Keep the arrange readable in place
(DAMP over DRY): helpers for setup are fine, helpers that hide the assertion
are not.

## Test doubles: real, then fake, then stub, then mock

Use the real thing until it is slow, external, or non-deterministic
(network, third-party service, clock, randomness, a large filesystem). Then
prefer, in order: a **fake** (working in-memory implementation of the same
interface), a **stub** (canned answer), a **mock** (asserts how it was
called). A mock is right only when the call itself is the contract: a
notification was sent once, with this payload.

Rules that hold at every level:

- Mock the level below the side effects the test depends on. Learn what the
  real method does first; a mock that swallows the config write the assertion
  reads passes for the wrong reason.
- A double mirrors the complete real structure, all documented fields, not
  just the ones this test reads; partial doubles pass while integration
  breaks.
- The mock earns no assertions about its own existence. If the assertion
  fails only when the mock is removed, unmock it or delete the assertion.
- A "was not called" assertion also passes when the test never reaches the
  call site or watches the wrong dependency. Pair it with a case that drives
  the same dependency with inputs that require the call, and asserts it.
- Give each branch (success, error, malformed) its own fixture, so the wrong
  branch cannot satisfy the expectation.
- Cleanup only tests need lives in test utilities, never as a method on the
  production class.
- Mock setup longer than the test logic, or breaking whenever the mock
  changes: switch to an integration test with real components.

## Sizes and determinism

Push each test to the smallest size that can catch its break: unit for the
pure core (milliseconds, no I/O), integration for one real boundary (DB,
file, subprocess), end-to-end for a few critical paths only. Inject the clock
and randomness; no sleeps, no order dependence, no shared mutable fixtures;
every test passes alone and in the full suite. A flaky test is a bug to fix
or a test to delete, never one to retry.

## Characterisation tests before touching legacy code

For code with no tests and unclear intent, pin what it does today: capture
the current output for representative inputs as the expected value
(approval or golden style is fine), including behaviour you believe is
wrong, with a comment marking the quirk. Refactor under that net. Then fix
the quirk in its own commit and update the expectation to the intended
behaviour. Writing the "correct" expectation first turns a refactoring into
an undiagnosed behaviour change.

## Property-based tests where the contract is a property

Use a property test when the contract is stated over all inputs rather than
examples: round-trips (`decode(encode(x)) == x`), idempotency
(`f(f(x)) == f(x)`), invariants preserved under any operation, ordering
independence, "the parser never throws on arbitrary bytes". Use the
property-testing library already installed for the stack (fast-check,
Hypothesis, QuickCheck-style ports); do not add one for a single property.
Keep one concrete example beside the property so a failure reads plainly,
and let the library shrink the counterexample.

For state that several operations touch, check the behaviour list's rules
with a stateful property test: the library generates sequences of operations
(and, for async code, their interleavings), runs them against the real
implementation, and checks every rule after each step, optionally against a
simple model of the expected state. fast-check has `fc.commands` with
`fc.modelRun`, and `fc.scheduler` for async interleavings; Hypothesis has
`RuleBasedStateMachine` with `@rule` and `@invariant`. Generate at least two
actors and split each operation where the real one can be interrupted (check,
then commit); with one actor or atomic steps the generator can never produce
the interleaving.

When the rules must hold across processes or services (payments,
replication, a distributed protocol) and the design can still change, a
model checker visits every reachable state of a small model instead of
sampling: Quint (TypeScript-like syntax over TLA+) with
`quint verify --invariant=<rule> --backend=tlc`, which prints the steps that
lead to a violation. The verdict covers only the small world modelled (three
users, two tickets), not every size, though most interleaving bugs already
appear there. To check that the code matches the model, `quint run --mbt`
writes traces and one test replays each trace against the implementation,
comparing state after every step. Add Quint only where the project already
uses it or the user agrees; the stateful property test needs no new tool.

## Differential tests where the old system is the oracle

When a rewrite or migration must keep behaviour and the old implementation
still runs, feed both the same inputs and diff the outputs: generated inputs
or a sample of real traffic, not only hand-picked examples. Normalise what
may legitimately differ (whitespace, ordering, timestamps) and keep the
intended differences as an explicit list; any other difference is a bug or
an unannounced breaking change.

## Blast radius of an existing diff

When a diff looks small but you cannot vouch for it, or someone asks what it
can break, look for breakage grep does not show; listing callers is grep's
job, not this one.

1. Describe the behaviour the diff adds, changes, or removes, including what
   the diff does not spell out.
2. Find the one or two facts that make it safe ("this call only drops caches
   that are already invalid"). Most scary-looking changes are made safe by
   one such fact, so spend time here before enumerating risks.
3. Look where grep does not reach: the source and local patches of the
   library version in use, timing (microtasks, teardown), the JSON an API
   returns, DB columns, wire formats and other-language readers of the same
   bytes, feature flags, consumers several hops downstream.
4. For each safety fact, state how far you raised it: (1) asserted, worthless
   alone; (2) cited `file:line` or the library source; (3) traced the failure
   path step by step to show it is unreachable; (4) ran a script or test that
   calls the real code; (5) reproduced it in the running app. Raise it to (4)
   when that is cheap and paste the output; below that, call it unproven.

Report the safety facts with their level and evidence, what you checked and
found fine, and the smallest test or repro to run before merging.

## Mutation check before finishing

Mentally mutate the production code and confirm at least one test fails for
each realistic mutation: wrong constant or argument, wrong branch handler,
missing state change or side effect, empty or default return, missing
validation of zero, empty, nil, unauthorised, or malformed input. A mutation
nothing catches marks the behaviour unprotected or the test tautological;
fix one or the other before yielding. The check covers only code that
exists; a case with no branch at all is the viewpoint walk's job.

## Delete these on sight

Tests that pin wording, private structure, or source text; mirror
assertions; bare "does not throw" or "length grew"; tests that can fail only
through a crash; tests whose setup and assertion share the same object;
same-path parameter rows that exercise nothing new; tests written for
coverage that check no outcome. This applies regardless of who wrote them;
never re-pin such a test to the new text.

Sources: obra/superpowers `test-driven-development/writing-good-tests.md`
(name the break, mock gates, mutation check); addyosmani/agent-skills
`test-driven-development` (discover the stack first, real over fake over
stub over mock, DAMP); Feathers, *Working Effectively with Legacy Code*
(characterisation tests); Khorikov, *Unit Testing Principles, Practices, and
Patterns* (邦訳『単体テストの考え方/使い方』; depth by kind of code); 市川裕也
「AIがテストを書く中で、『あるべき仕様』を単体テストで担保するために工夫して
みていること」, future-architect.github.io/articles/20260615a (behaviour
list before implementing, exclusion vocabulary, readable behaviour items);
poteto's pstack `blast-radius` (`cursor/plugins`); Addy Osmani, "How the
Claude Code team thinks about verification" (claude.dev, 2026-11-16;
differential tests); karamage「【TLA+】AIにテストケースを書かせるな。ルールを
書け」, zenn.dev/karamage/articles/73027ee36796dc (2026-11-21; rules over
cases, check-then-act, Quint model checking and model-based testing).
