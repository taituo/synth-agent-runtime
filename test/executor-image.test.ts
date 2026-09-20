/**
 * The executor image is the repo's own and pinned by digest.
 *
 * A floating tag (`ghcr.io/example/synth-executor:latest`) makes a sandbox run
 * unreproducible and lets the boundary change under it. Pin the repo image
 * built from `deploy/executor-image`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_KUBERNETES_RESOURCE_CLASSES,
  EXECUTOR_IMAGE,
  EXECUTOR_IMAGE_DOCKERFILE,
} from "../src/index.js";

const DIGEST_PINNED = /^[A-Za-z0-9._/:-]+@sha256:[0-9a-f]{64}$/;

test("every default resource class uses the digest-pinned repo executor image", () => {
  assert.match(EXECUTOR_IMAGE, DIGEST_PINNED, `executor image must be digest-pinned: ${EXECUTOR_IMAGE}`);
  for (const entry of DEFAULT_KUBERNETES_RESOURCE_CLASSES) {
    assert.match(entry.image, DIGEST_PINNED, `class ${entry.id} image must be digest-pinned: ${entry.image}`);
    assert.equal(entry.image, EXECUTOR_IMAGE, `class ${entry.id} must use the shared executor image`);
    assert.ok(!/:latest$/.test(entry.image), `class ${entry.id} must not use a floating tag`);
    assert.ok(!entry.image.includes("ghcr.io/example/"), `class ${entry.id} must not use the placeholder image`);
  }
});

test("the pinned image is built from deploy/executor-image with a non-root user", () => {
  const dockerfile = readFileSync(
    fileURLToPath(new URL(`../../${EXECUTOR_IMAGE_DOCKERFILE}`, import.meta.url)),
    "utf8",
  );
  assert.match(dockerfile, /^FROM node:22-bookworm-slim@sha256:[0-9a-f]{64}$/m, "the Dockerfile base must be digest-pinned");
  assert.match(dockerfile, /^USER 65532:65532$/m, "the executor must run as the non-root synth user");
});
