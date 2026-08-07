Add a semantic-version comparator and range matcher

Create `semver.js` in the repository root exporting two functions,
`compare(a, b)` and `satisfies(version, range)`.

Do not use any dependency. It must never throw.

## `compare(a, b)`

Returns `-1` if `a` is lower precedence than `b`, `1` if higher, `0` if equal.
If either argument is not a valid version, return `null`.

A valid version is `MAJOR.MINOR.PATCH`, each a non-negative integer with no
leading zeroes, optionally followed by `-PRERELEASE` and then optionally
`+BUILD`. A leading `v` is accepted and ignored. Precedence rules:

- Compare major, then minor, then patch numerically.
- Build metadata is ignored entirely. `1.0.0+a` and `1.0.0+b` are equal.
- A version with a prerelease is **lower** than the same version without one.
  `1.0.0-alpha` < `1.0.0`.
- Prerelease is a dot-separated list of identifiers, compared left to right.
  A purely numeric identifier is compared numerically; anything else is
  compared as ASCII. A numeric identifier is always lower than a non-numeric
  one. If all shared identifiers are equal, the list with **more** identifiers
  is higher.

So this ordering must hold:

```
1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta
  < 1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0
```

## `satisfies(version, range)`

Returns `true` if `version` is within `range`, otherwise `false`. An invalid
version or an unparseable range returns `false`.

A range is one or more comparator sets separated by `||`. The version satisfies
the range if it satisfies **any** set. A comparator set is one or more
comparators separated by whitespace, and the version must satisfy **all** of
them. A comparator is an operator (`<`, `<=`, `>`, `>=`, `=`, or none, meaning
`=`) followed by a version. Support also:

- `*` or an empty range — matches any version that has no prerelease.
- `^1.2.3` — at least `1.2.3`, below the next **major**: `>=1.2.3 <2.0.0`.
- `^0.2.3` — for a zero major, the **minor** is the boundary:
  `>=0.2.3 <0.3.0`.
- `^0.0.3` — for a zero major and zero minor, the **patch** is:
  `>=0.0.3 <0.0.4`.
- `~1.2.3` — at least `1.2.3`, below the next **minor**: `>=1.2.3 <1.3.0`.
- `~1.2` — `>=1.2.0 <1.3.0`.

**Prereleases are excluded unless asked for.** A version with a prerelease
satisfies a comparator set only if at least one comparator in that set names a
version with a prerelease *and* the same major, minor and patch. So
`1.2.3-alpha` does not satisfy `>=1.0.0`, and does satisfy `>=1.2.3-alpha`.

Also add tests for the module in the repository, and make sure they pass.
