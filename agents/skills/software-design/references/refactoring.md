# Refactoring

1. **Characterise first.** If the code you will move has no tests, write
   characterisation tests that pin the current behaviour, quirks included
   (see `test-design`). Do not fix the quirk yet.
2. **Find the seam.** A place where behaviour can be altered without editing
   the code in place: an injected dependency, a function boundary, a module
   export. Create one with a rename or an extracted parameter if none exists.
3. **One small behaviour-preserving step, then run the tests.** Rename,
   extract function, move function, inline, introduce parameter object,
   replace conditional with polymorphism: one per step. Use the language
   server for renames and `structural-edit` for repeated shape changes; hand
   edits miss call sites. After a rename, search strings, docs, and config
   for the old name; the language server does not see them.
4. **Commit each green step** (`refactor:` subject, the reason in the body).
   Tests break in an unexpected way: revert the step, do not debug it. A
   green step that does not make the code easier to read is not worth
   keeping either; revert it.
5. **Fix behaviour afterwards** in a separate commit, updating the
   characterisation test to the intended behaviour.

Smell to move, for the smells that matter:

| Smell | Move |
| --- | --- |
| Long parameter list, same group passed around | Parameter object or value type |
| Function uses another object's data more than its own | Move function |
| Same shape in three places | Extract on the third copy, not the second |
| Primitive standing in for a concept (string id, int cents) | Value type carrying its invariant |
| Flag argument switching behaviour | Two functions |
| Nested conditionals | Guard clauses, early return |
| Comment explaining what the next lines do | Rename or extract until the comment is redundant |
| Interface, hook, or option nobody uses | Delete |
| Caller imports another module's internals | Export a public entry point; import only that |
| Two lists kept in sync by hand | Derive one from the other |
| Flags for mutually exclusive states (`isDraft` and `isPublished`) | One state field whose values are the legal states; keep independent flags separate |
| Modules named after steps (read, parse, write) that all know one format | Split by the decision each hides, not by execution order |
