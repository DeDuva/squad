Make the CSV importer correct and fast

This repository contains a small CSV reader. `README.md` describes the format
it is meant to accept, `consumers/` holds three programs built on it, and
`bench/parse.js` measures how long it takes to parse a large document.

Three things are wrong with it, and the existing test suite does not catch any
of them. Your job is to find and fix them.

1. **Correctness.** The parser does not accept everything README.md says it
   accepts. Read that description carefully and check the implementation
   against it — the shipped tests pass, so they are not the place to look.

2. **Performance.** `bench/parse.js` takes far longer than it should on
   20,000 records. It should comfortably parse them in well under a tenth of a
   second.

3. **Whatever else you find.** If the documentation and the code disagree
   about what the right behaviour is, do not guess silently. Decide which
   should win, do that, and write your reasoning in a file called `NOTES.md`
   at the repository root — say what the conflict was, what you chose, and
   why.

`consumers/` is the package's public contract. Whatever you change inside,
those three programs must keep working.

Add tests for the behaviour you fix, and make sure the whole suite passes.
