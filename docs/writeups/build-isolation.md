# How build isolation is enforced

_Coming soon — this write-up lands once the proxy + build path has more real mileage behind it._

Will cover: per-container resource limits and capability drops, the Docker-socket-proxy vs.
raw-socket-mount split between Traefik and the worker, why build args are never used for
secrets, and the honestly-stated gaps (no gVisor/Kata, no egress filtering) — see
[SECURITY.md](../SECURITY.md).
