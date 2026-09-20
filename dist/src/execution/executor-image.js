/**
 * The executor image: where untrusted agent code physically runs.
 *
 * It is built from `deploy/executor-image/Dockerfile` (`FROM
 * node:22-bookworm-slim@sha256:48e4...`, `USER 65532:65532`) and pinned by
 * digest here, so a sandbox run is reproducible: a floating tag would let the
 * boundary change under a run. The Dockerfile carries node and git because
 * `run_visible_test` and the git transport both execute inside the pod.
 *
 * Build it and make it available to the cluster:
 *
 *   podman build -t synth-executor:0.1.0 deploy/executor-image
 *   podman tag synth-executor:0.1.0 ghcr.io/taituo/synth-executor:0.1.0
 *   podman save --format docker-archive -o executor.tar ghcr.io/taituo/synth-executor:0.1.0
 *   sudo k3s ctr -n k8s.io images import executor.tar
 *   sudo k3s ctr -n k8s.io images tag \
 *     ghcr.io/taituo/synth-executor:0.1.0 \
 *     ghcr.io/taituo/synth-executor@sha256:<digest>
 *
 * The digest below is the manifest digest of that build. Publishing a new
 * executor means replacing this whole reference, not the tag on it.
 */
export const EXECUTOR_IMAGE = "ghcr.io/taituo/synth-executor@sha256:fc59cec2b7a3733e9e50db1d5063669c60ec7add0d18a338b2a3f19a422c822f";
/** The Dockerfile this image is built from, repo-relative. */
export const EXECUTOR_IMAGE_DOCKERFILE = "deploy/executor-image/Dockerfile";
