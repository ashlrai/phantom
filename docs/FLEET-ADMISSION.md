# Fleet Admission Control

Fleet jobs wait to start because of admission control. The fleet uses admission gates to prevent overloading the system.

## What Is Admission?

Admission is a system that determines when and whether a new fleet job can start. The fleet waits between job starts to ensure system stability. Jobs are admitted to run only when the system has sufficient capacity.

## Admission Control File

The admission control state is stored in `~/.ashlr-runs/queue/admission-ctl.json`. Key fields include:

- `settle_s`: The minimum time (in seconds) between job starts, or "settling" interval. 
- `why`: The reason why new jobs are not being admitted currently: settling, over_host, or open. 
- `load1`: Current system load (1-minute average).
- `owned_load1`: Load from the fleet's own work (not including external processes).
- `total_running`: Total number of jobs currently running across all lanes.
- `max_total_running`: Maximum total number of jobs that can run at once.

## Common Reasons for Waiting

### Settling (`why: "settling"`)
When the system is "settling", it's waiting to ensure enough time has passed since the last job started. This prevents jobs from starting too rapidly and overwhelming system resources. The settling interval is controlled by `settle_s`.

### Over Host (`why: "over_host"`)
When `why` is "over_host", it means the system is too busy. This is not necessarily due to the fleet's own jobs, but can include external processes like Spotlight indexing, other applications, or system overhead. The fleet may be running jobs at a rate that's too high for the host to handle efficiently.

### Open (`why: "open"`)
When `why` is "open", it means the system has capacity to run more jobs. This is the optimal state where new jobs can start immediately.

## Starts Per Hour

With a settle interval of `settle_s` seconds, the fleet can start approximately `3600 / settle_s` jobs per hour. For example, with `settle_s = 60`, the system can start 60 jobs per hour (1 job per minute).

## See Also

- [Queue system documentation](QUEUE.md) 
- [Fleet coordination](FLEET-COORDINATION.md)
- [Agent network](AGENT-NETWORK.md)
