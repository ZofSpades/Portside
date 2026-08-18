# How the dynamic reverse proxy routing works

_Coming soon — this write-up lands once the proxy + build path has more real mileage behind it._

Will cover: why Traefik + Docker-provider labels over an Nginx config-rewrite approach, the
`portside-internal` / `portside-apps` network split, the pure-function label generator in
`packages/docker/labels.ts` and how it's unit-tested, and the priority-based cutover mechanics
for zero-downtime deploys.
