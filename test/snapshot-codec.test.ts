/**
 * Artifact-egress mechanism 1: the inline snapshot is bounded. Small results
 * round-trip; an overlay above the ceiling fails loudly (never silently
 * truncated) and tells the caller to use the git transport or the blob store.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_INLINE_SNAPSHOT_BYTES,
  deserializeWorkspaceSnapshot,
  serializeWorkspaceSnapshot,
  type WorkspaceSnapshot,
} from "../src/index.js";

function snapshot(overlay: Record<string, Uint8Array | string>, links: Record<string, string> = {}): WorkspaceSnapshot {
  return {
    id: "ws_test" as WorkspaceSnapshot["id"],
    overlay: new Map(Object.entries(overlay).map(([path, value]) => [path, typeof value === "string" ? new TextEncoder().encode(value) : value])),
    links: new Map(Object.entries(links)),
    deleted: new Set(),
    changed: new Set(Object.keys(overlay)),
  };
}

test("a small snapshot round-trips, preserving overlay and links", () => {
  const serialized = serializeWorkspaceSnapshot(snapshot({ "a.txt": "hello" }, { "link.txt": "a.txt" }));
  const restored = deserializeWorkspaceSnapshot(serialized);
  assert.equal(new TextDecoder().decode(restored.overlay.get("a.txt")!), "hello");
  assert.equal(restored.links?.get("link.txt"), "a.txt");
});

test("an overlay above the ceiling fails loudly instead of bloating history", () => {
  assert.throws(
    () => serializeWorkspaceSnapshot(snapshot({ "big.bin": new Uint8Array(MAX_INLINE_SNAPSHOT_BYTES + 1) })),
    (error: unknown) => {
      assert.match(String(error), /INLINE_SNAPSHOT_TOO_LARGE/);
      return true;
    },
  );
});

test("the boundary: exactly the ceiling is allowed, one byte more is not", () => {
  assert.doesNotThrow(() => serializeWorkspaceSnapshot(snapshot({ "exact.bin": new Uint8Array(MAX_INLINE_SNAPSHOT_BYTES) })));
  assert.throws(() => serializeWorkspaceSnapshot(snapshot({ "over.bin": new Uint8Array(MAX_INLINE_SNAPSHOT_BYTES + 1) })), /INLINE_SNAPSHOT_TOO_LARGE/);
});
