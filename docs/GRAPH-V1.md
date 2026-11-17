# Graph registry snapshots

`phm graph status --fleet <fleet.json> --seats <seats.json> --json` reads
declared fleet relationships and seat catalogs as a `graph.v1` projection.
These declarations do not establish runtime health or execution authority.

Either snapshot option selects registry output. Omitted fleet input defaults
to `./fleet.json`; omitted seats use passive native account and model metadata.
The reader does not probe providers or start seat discovery.

Sources must be regular files containing valid JSON, at most 2 MiB each.
Symlinks, directories, unstable reads and oversized files are refused. Missing,
invalid and unavailable inputs remain explicit in `sources` and `issues`.
Input contents and private paths are withheld from errors.

Exit 0 means a complete projection, 1 means incomplete or unavailable data,
and 2 means invalid arguments. Without `--json`, the command prints sources,
nodes, edges and issues. Without either snapshot option, `graph status`
continues to use the existing inventory loader.
