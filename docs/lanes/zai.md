# Z.ai GLM Coding Lite lane

Phantom runs coding tasks on Z.ai models through the GLM Coding Lite lane.
The lane exposes two models, each mapped to a queue tier: **glm-5.3**
(`work`) and **glm-5.3-flash** (`fast`). The lane is part of the published
Phantom package. Tests use loopback fixtures, not live API credits.

## Models and tiers

| Model          | Tier   |
| -------------- | ------ |
| glm-5.3        | work   |
| glm-5.3-flash  | fast   |

A queue router maps `tier=work` to glm-5.3 and `tier=fast` to glm-5.3-flash.
Unknown tier values are rejected; `standard` is normalised to `work`.

## Credit formula

Credit consumption is calculated per request as:

- **glm-5.3:** `(inputTokens*6.9 + cacheReadTokens*1.7 + outputTokens*24) / 10000`
- **glm-5.3-flash:** input credits `2.3`, cache credits `0.56`, output credits `8` (all per 1 000 tokens, no divisor).

The lane reports the dollar-equivalent in usage records. No real spending
information is read, logged, or printed by Phantom. The formula is a
calculation only; it does not prove the account holds sufficient funds.

## Included allowance

Each authenticated Z.ai account receives:

- **2 000 credits** every 5 hours (rolling window).
- **10 000 credits** per week (calendar week).

Credits are consumed in order, starting with the weekly bucket then the
rolling 5-hour bucket. Running out of credits stops new task admission; it
does not cancel an in-flight request. Credits never reset early: a window
expires only when its 5 hours or week elapses.

## Rolling-window pacing

The 5-hour bucket uses a rolling window, not a fixed period. Each task start
advances the window start by five hours. Tasks submitted before the window
expires draw from it; otherwise they wait or fail with `quota_exhausted`.
The weekly bucket is a calendar-week counter that resets on Monday 00:00 UTC.
Phantom does not reorder or prioritise tasks across buckets; it only checks
whether each bucket has remaining credits.

## Error classes

The lane emits three error classes:

| Code               | Meaning                                          | Recovery action                     |
| ------------------ | ------------------------------------------------- | ----------------------------------- |
| `quota_exhausted`  | Both the rolling 5-hour bucket and weekly bucket are at zero. | Wait for a window to replenish.     |
| `auth_failed`      | The authenticated session is missing, expired, or revoked. | Refresh auth through Phantom Secrets. |
| `rate_limited`     | Z.ai returned an HTTP 429 with a retry-after header. | Honour the retry-after window and retry once. |

No retry is attempted on `quota_exhausted`. The lane never exposes a raw
response body, status code, or credential in logs. Only the error code is
recorded.

## Secrets transport

The lane uses a Phantom Secrets-owned endpoint for token injection. The
endpoint URL and bearer token are stored in Phantom Secrets and never appear
in logs, environment variables, or CLI output. Phantom calls the endpoint on
behalf of the lane and injects the token into the request header. No new
secrets are created or printed.

## Test fixtures

Fixture-based tests use a loopback server that returns a fixed credit balance,
a mocked Z.ai response, and each error class. No live API calls, credentials,
or token values are used.
