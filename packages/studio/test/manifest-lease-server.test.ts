import assert from "node:assert/strict";
import test from "node:test";

import { StudioAssetManifestChanged } from "../src/asset-manifest.js";
import { commitManifestLeasedSourceMutation, validMediaReplaceRequest } from "../src/server.js";

const sha = "a".repeat(64);

test("media replacement request boundary requires a lowercase manifest sha256", () => {
  assert.equal(validMediaReplaceRequest({ itemId: "item", assetId: "asset_clip", manifestSha256: sha }), true);
  assert.equal(validMediaReplaceRequest({ itemId: "item", assetId: "asset_clip" }), false);
  assert.equal(validMediaReplaceRequest({ itemId: "item", assetId: "asset_clip", manifestSha256: "bad" }), false);
  assert.equal(validMediaReplaceRequest({ itemId: "item", assetId: "asset_clip", manifestSha256: "A".repeat(64) }), false);
});

test("manifest mismatch before apply rejects without touching Source", async () => {
  let applied = false;
  await assert.rejects(commitManifestLeasedSourceMutation({
    lease: { async assertCurrent() { throw new StudioAssetManifestChanged("Asset manifest changed outside Studio."); } },
    async apply() { applied = true; return "preimage"; },
    async publishAndValidate() { return 2; },
    async restoreAndPublish() {},
  }), StudioAssetManifestChanged);
  assert.equal(applied, false);
});

test("manifest drift after Source write restores the preimage and republishes before rejecting", async () => {
  const events: string[] = [];
  let checks = 0;
  await assert.rejects(commitManifestLeasedSourceMutation({
    lease: { async assertCurrent() {
      checks += 1;
      events.push(`check:${checks}`);
      if (checks === 2) throw new StudioAssetManifestChanged("Asset manifest changed outside Studio.");
    } },
    async apply() { events.push("apply"); return "source-preimage"; },
    async publishAndValidate() { events.push("publish"); return 2; },
    async restoreAndPublish(previous) { events.push(`restore:${previous}`); events.push("republish"); },
  }), StudioAssetManifestChanged);
  assert.deepEqual(events, ["check:1", "apply", "check:2", "restore:source-preimage", "republish"]);
});

test("manifest drift after publish also restores Source before returning conflict", async () => {
  const events: string[] = [];
  let checks = 0;
  await assert.rejects(commitManifestLeasedSourceMutation({
    lease: { async assertCurrent() {
      checks += 1;
      events.push(`check:${checks}`);
      if (checks === 3) throw new StudioAssetManifestChanged("Asset manifest changed outside Studio.");
    } },
    async apply() { events.push("apply"); return "source-preimage"; },
    async publishAndValidate() { events.push("publish"); return 2; },
    async restoreAndPublish(previous) { events.push(`restore:${previous}`); events.push("republish"); },
  }), StudioAssetManifestChanged);
  assert.deepEqual(events, ["check:1", "apply", "check:2", "publish", "check:3", "restore:source-preimage", "republish"]);
});
