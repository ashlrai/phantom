# Implementation findings

No drive command, driver daemon, metrics command, restock implementation or publish.sh exists in this checkout. Use an explicit versioned local file contract until the driver lands. Reuse fleet CLI dispatch and fleet digest aggregation. Keep transport responsibility with Masbot. Protected paths were inspected read-only.
