FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates bash coreutils findutils grep sed diffutils \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 65532 --user-group --create-home synth

USER 65532:65532
WORKDIR /workspace
CMD ["/bin/sh", "-lc", "trap : TERM INT; sleep infinity & wait"]
