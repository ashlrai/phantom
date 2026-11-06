# Second computer options

Mason's Nov 1 order: any paid machine or plan needs his explicit yes first.
This page lists priced options so he can answer with one word. It buys nothing.

## Recommendation

Buy the **base Mac mini M6 (16 GB, 256 GB) for $899** and leave it on at home.
It is the only option that does all three jobs cleanly: it stays up when the
MacBook is off and takes over as leader, it adds real parallel compute when
both are up, and because it is a physical Mac Mason owns, it can sign into his
Apple Account and sync iCloud Keychain — which the Safari agent-browser role
requires and a Linux box or macOS VM cannot provide. There is no monthly bill
and his Apple Account never sits on hardware in someone else's datacenter. The
$1,799 build (32 GB, 1 TB) is the upgrade if he wants more parallel headroom;
it is not needed to start.

## Options

| Option | Upfront cost | Monthly cost | Memory | Safari and iCloud possible | What it takes to set up | Source URL | Date checked |
|--------|--------------|--------------|--------|----------------------------|-------------------------|------------|--------------|
| Mac mini at home, base (M6, 256 GB) | $899 one-time | $0 | 16 GB | yes | Order from Apple; plug in at home; sign in to Mason's Apple Account; turn on iCloud Keychain sync; install Node and check out this repo; share SSH trust with the coordinator | https://www.apple.com/shop/buy-mac/mac-mini/m6-chip-12-core-cpu-12-core-gpu-16gb-memory-256gb-storage | 2026-11-02 |
| Mac mini at home, higher memory (M6, 1 TB) | $1,799 one-time | $0 | 32 GB | yes | Same as the base model | https://www.apple.com/shop/buy-mac/mac-mini/m6-chip-12-core-cpu-12-core-gpu-32gb-memory-1tb-storage | 2026-11-02 |
| MacStadium dedicated Mac mini (M4.S) | $0 | $149 (monthly prepay on the 1st) | 16 GB | yes | Create a portal account, order the dedicated mini, enable SSH and Screen Sharing; real Apple hardware Mason controls remotely | https://www.macstadium.com/pricing | 2026-11-02 |
| AWS EC2 Mac dedicated host (mac-m4.metal) | $0 | unverified — AWS's dedicated-host price table loads only in JavaScript | 24 GiB | yes | AWS account; allocate a dedicated host; launch a macOS AMI; connect by SSH or Screen Sharing; billed per second with a 24-hour minimum allocation | https://aws.amazon.com/ec2/dedicated-hosts/pricing/ | 2026-11-02 |
| Scaleway Apple silicon Mac mini (M4-S) | $0 | €149 (€0.22/hour; vendor states a 24-hour minimum lease) | 16 GB | yes | Scaleway account; order the bare-metal mini in Paris; reach it by console/VNC then SSH | https://www.scaleway.com/en/pricing/apple-silicon/ | 2026-11-02 |
| Linux VPS coordinator only (Hetzner Cloud, cost-optimized shared) | $0 | from €5.99 excl. VAT | shared | no | Hetzner account; create a small cloud instance; it holds the lease DB and shared queue over SSH; no macOS, so no Safari or iCloud | https://www.hetzner.com/cloud/ | 2026-11-02 |

## What each choice leaves undone

- **Home Mac mini.** Nothing in the order is left undone, but it shares the
  home's power and internet with the MacBook — a home outage drops both. It is
  also the only option needing real cash up front.
- **Hosted Macs (MacStadium, Scaleway, AWS EC2 Mac).** Real Apple hardware, so
  Safari runs and Apple Account sign-in is technically possible — unlike a
  macOS VM, which Apple blocks from iCloud. But sign-in on datacenter hardware
  is not a vendor-supported feature, Mason's iCloud Keychain would live on a
  machine he does not physically control, and the bill repeats every month.
  AWS's actual price could not be verified from its page today.
- **Linux VPS.** The cheapest always-on coordinator: it keeps the fenced lease
  DB and shared queue alive so failover and job claims still work while the
  MacBook sleeps. It cannot ever be the Safari browser, has no iCloud, and is
  too small to matter as parallel compute — the browser role still needs a Mac.

Nothing has been bought: every paid option above needs Mason's explicit yes.
