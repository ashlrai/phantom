# Implementation notes

Reset pressure and subscription usage are protected read dependencies. Account rows use capacity snapshots and current budget policy. Engine-wide subscription readings must never be attributed to an account. Missing personal telemetry remains unknown. The final user instruction overrides the queue request to publish a PR.
