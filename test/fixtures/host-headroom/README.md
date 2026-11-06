# macOS host headroom recordings

Captured on 2026-10-26 with `/usr/bin/vm_stat` and
`/usr/sbin/sysctl vm.swapusage`. Physical memory (`sysctl -n hw.memsize`)
was 137438953472 bytes. These files contain only host memory counters.

Free percent counts free plus speculative pages, excluding inactive,
purgeable, and compressed pages. Swap GB means GiB (1024 cubed bytes),
matching macOS binary unit reporting. Tests cover other page sizes and
units with explicitly constructed inputs.
