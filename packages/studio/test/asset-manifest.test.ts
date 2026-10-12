import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadStudioAssetManifest, StudioAssetManifestChanged, StudioAssetRejected } from "../src/asset-manifest.js";

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function document(path: string, bytes: Uint8Array): string {
  return JSON.stringify({ format: "narralens.asset-manifest@1", assets: [{
    asset_id: "asset_local_video", project_path: path, sha256: digest(bytes), media_type: "video/mp4",
    kind: "video", duration_frames: 300, source: { kind: "generated", label: "test fixture" },
    license: { status: "cleared", label: "test-owned", commercial_use: true },
  }] });
}

test("asset manifest resolves only unchanged contained bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "hypit-studio-assets-"));
  await mkdir(join(root, "assets"));
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  await writeFile(join(root, "assets", "clip.mp4"), bytes);
  const manifestPath = join(root, "narralens.assets.json");
  await writeFile(manifestPath, document("assets/clip.mp4", bytes));
  const manifest = await loadStudioAssetManifest(manifestPath, root);
  const asset = await manifest.resolve("asset_local_video");
  assert.equal(asset.sha256, digest(bytes));
  assert.equal((await manifest.identifyLocator(join(root, "authors", "main.svml"), "../assets/clip.mp4"))?.assetId, asset.assetId);
  await writeFile(join(root, "assets", "clip.mp4"), Uint8Array.from([9]));
  await assert.rejects(manifest.resolve(asset.assetId), StudioAssetRejected);
});

test("asset manifest freezes authorization bytes and rejects symlink escape", async () => {
  const root = await mkdtemp(join(tmpdir(), "hypit-studio-assets-"));
  const outside = await mkdtemp(join(tmpdir(), "hypit-studio-outside-"));
  const bytes = Uint8Array.from([4, 3, 2, 1]);
  await writeFile(join(outside, "clip.mp4"), bytes);
  await symlink(join(outside, "clip.mp4"), join(root, "linked.mp4"));
  const manifestPath = join(root, "narralens.assets.json");
  await writeFile(manifestPath, document("linked.mp4", bytes));
  const manifest = await loadStudioAssetManifest(manifestPath, root);
  await assert.rejects(manifest.resolve("asset_local_video"), StudioAssetRejected);
  await writeFile(manifestPath, `${document("linked.mp4", bytes)}\n`);
  await assert.rejects(manifest.resolve("asset_local_video"), StudioAssetManifestChanged);
});
