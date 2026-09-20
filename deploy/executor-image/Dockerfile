# Base pinned by digest (multi-arch index). The executor image itself is pinned
# by digest in src/execution/executor-image.ts; tags are not reproducible.
FROM node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates bash coreutils findutils grep sed diffutils \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 65532 --user-group --create-home synth

USER 65532:65532
WORKDIR /workspace
CMD ["/bin/sh", "-lc", "trap : TERM INT; sleep infinity & wait"]
