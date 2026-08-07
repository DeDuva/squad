Add an async retry helper

Create `retry.js` in the repository root exporting an async function
`retry(fn, options)`.

It calls `fn` and returns its resolved value. If `fn` rejects, it waits and
calls it again, until the value resolves or the attempts run out.

`fn` is called as `fn(attempt)` where `attempt` is 1 for the first call, 2 for
the second, and so on.

`options` is optional and may contain:

- `retries` — how many *additional* attempts after the first. Default `3`, so
  the default total is four calls. `retries: 0` means `fn` is called once.
- `baseMs` — the first delay, in milliseconds. Default `100`.
- `factor` — the multiplier applied per attempt. Default `2`.
- `maxDelayMs` — an upper bound on any single delay. Default `Infinity`.
- `shouldRetry(error, attempt)` — if it returns a falsy value the retry stops
  immediately and `retry` rejects with that error, even if attempts remain.
  Default: always retry.
- `onRetry(error, attempt, delayMs)` — called once before each wait, with the
  error that caused it, the attempt number that just failed, and the delay
  about to be waited. Default: no-op.
- `signal` — an `AbortSignal`. If it is already aborted, `retry` rejects with
  the signal's reason without calling `fn` at all. If it aborts during a wait,
  `retry` rejects with the signal's reason and does not call `fn` again.

The delay before attempt *n+1* is `baseMs * factor ** (n - 1)`, clamped to
`maxDelayMs`. So with the defaults the delays are 100, 200, 400.

When every attempt fails, `retry` rejects with the error from the **last**
attempt.

A `fn` that resolves is never retried, and `onRetry` is not called after the
final failure — it announces a wait, and there is no wait after the last
attempt.

Also add tests for the module in the repository, and make sure they pass.
