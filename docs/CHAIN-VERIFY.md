# Synthetic chain verification

Run `phm chain verify --json` to exercise a synthetic resource reading through
resource projection, seat selection, node load planning, correlated agent bus
request, parallel fan-out, and inbound human-channel acknowledgement. The
versioned report gives pass, fail or blocked and monotonic elapsed milliseconds
for each link. A failure blocks downstream checks; blocked latency is null.
Exit codes are 0 for all passed, 1 for failure, and 2 for invalid usage.

The inputs, nodes, bus responses, channel sink and acknowledgement are entirely
in memory. No real message, model, provider, credential, merge or persistent store
is accessed. A pass proves these synthetic code paths, not live resource bars,
provider availability, agent delivery, human authentication or outbound delivery.
