# M1 — A real retry delay

Date: 2026-08-11. Status: **done**, proven against the live staging supervisor.

## What was wrong

`ExecutableTaskSupervisor.fail()` passed a hardcoded `1_000` as the retry delay
for every attempt. Nobody could see it while `retry_wait` was terminal in
practice, because no retry ever ran. CONTRACT-017's sweep made retries real and
the owner immediately watched it happen:

```
[06:52] ⚠️ Task retry_wait  … attempt 2
[06:52] ❌ Task failed      … attempt 3
```

Attempts 2 and 3 in the same second. A task exhausted its whole retry budget in
about two seconds and reached `failed`, which is terminal — so the retry
mechanism actively converted a transient failure into a permanent one faster
than any outage worth retrying through could clear.

## The fix

`retryDelayMs(attemptOrdinal)`: doubling from one second, capped at five
minutes. No jitter — jitter solves a thundering herd and this host runs one
supervisor.

A nonsense ordinal returns the base interval rather than zero, because
retrying instantly is the failure being fixed and must not be the fallback for
bad input either.

## Proven live, not by reading the code

A task that fails verification on every attempt, six attempts, no provider
involved so it cost nothing:

```
attempt 1: 02:02:46.790
attempt 2: 02:02:48.844   gap 2.054s
attempt 3: 02:02:50.893   gap 2.049s
attempt 4: 02:02:54.946   gap 4.053s
attempt 5: 02:03:03.023   gap 8.077s
attempt 6: 02:03:19.130   gap 16.107s
span: 32.3s
```

The first two gaps are floored at ~2s by the supervisor's poll interval: delays
of 1s and 2s both land on the next poll. From attempt 3 the doubling is exact.
Under the old constant the same six attempts would have spanned about ten
seconds, all of them inside one poll cadence.

**The same drill also proved the noise gate.** Five retries and one failure
would previously have sent six Telegram messages. It sent one: the ending.

`tests/retry-backoff.test.ts` covers the growth, the cap, the finiteness of the
intermediate at absurd ordinals, and the bad-input fallback.
