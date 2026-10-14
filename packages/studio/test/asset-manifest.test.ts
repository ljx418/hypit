import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadStudioAssetManifest, StudioAssetManifestChanged, StudioAssetRejected } from "../src/asset-manifest.js";

const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

function entry(id: string, path: string, bytes: Uint8Array, status: "cleared" | "restricted" | "unknown" = "cleared") {
  return {
    asset_id: id, project_path: path, sha256: digest(bytes), media_type: "video/mp4",
    kind: "video", duration_frames: 300, source: { kind: "generated", label: "test fixture" },
    license: { status, label: "test-owned", commercial_use: status === "cleared" },
  };
}

function document(path: string, bytes: Uint8Array, format = "narralens.asset-manifest@1"): string {
  return JSON.stringify({ format, assets: [entry("asset_local_video", path, bytes)] });
}

test("asset manifest resolves only unchanged contained bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "hypit-studio-assets-"));
  await mkdir(join(root, "assets"));
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  await writeFile(join(root, "assets", "clip.mp4"), bytes);
  const manifestPath = join(root, "narralens.assets.json");
  await writeFile(manifestPath, document("assets/clip.mp4", bytes));
  const manifest = await loadStudioAssetManifest(manifestPath, root);
  const view = await manifest.current();
  const asset = await view.resolve("asset_local_video");
  assert.equal(asset.sha256, digest(bytes));
  assert.equal((await view.identifyLocator(join(root, "authors", "main.svml"), "../assets/clip.mp4"))?.assetId, asset.assetId);
  await writeFile(join(root, "assets", "clip.mp4"), Uint8Array.from([9]));
  await assert.rejects(view.resolve(asset.assetId), StudioAssetRejected);
});

test("asset manifest lease freezes authorization bytes and rejects symlink escape", async () => {
  const root = await mkdtemp(join(tmpdir(), "hypit-studio-assets-"));
  const outside = await mkdtemp(join(tmpdir(), "hypit-studio-outside-"));
  const bytes = Uint8Array.from([4, 3, 2, 1]);
  await writeFile(join(outside, "clip.mp4"), bytes);
  await symlink(join(outside, "clip.mp4"), join(root, "linked.mp4"));
  const manifestPath = join(root, "narralens.assets.json");
  const initial = document("linked.mp4", bytes);
  await writeFile(manifestPath, initial);
  const manifest = await loadStudioAssetManifest(manifestPath, root);
  const lease = await manifest.lease(digest(initial));
  await assert.rejects(lease.resolve("asset_local_video"), StudioAssetRejected);
  await writeFile(manifestPath, `${initial}\n`);
  await assert.rejects(lease.assertCurrent(), StudioAssetManifestChanged);
  await assert.rejects(manifest.lease(digest(initial)), StudioAssetManifestChanged);
});

test("current views reload @2 without restart and restrict mutation targets without hiding inventory bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "hypit-studio-assets-"));
  await mkdir(join(root, "assets"));
  await mkdir(join(root, "authors"));
  const first = Uint8Array.from([1, 1, 1]);
  const second = Uint8Array.from([2, 2, 2]);
  await writeFile(join(root, "assets", "first.mp4"), first);
  await writeFile(join(root, "assets", "second.mp4"), second);
  const manifestPath = join(root, "narralens.assets.json");
  await writeFile(manifestPath, document("assets/first.mp4", first));
  const manifest = await loadStudioAssetManifest(manifestPath, root);
  const v2 = JSON.stringify({ format: "narralens.asset-manifest@2", assets: [
    entry("asset_missing", "assets/missing.mp4", Uint8Array.from([9]), "unknown"),
    entry("asset_local_video", "assets/first.mp4", first),
    entry("asset_restricted", "assets/second.mp4", second, "restricted"),
  ] });
  await writeFile(manifestPath, v2);
  const view = await manifest.current();
  assert.equal(view.sha256, digest(v2));
  assert.equal((await view.resolve("asset_local_video")).assetId, "asset_local_video");
  await assert.rejects(view.resolve("asset_restricted"), StudioAssetRejected);
  assert.equal((await view.identifyLocator(join(root, "authors", "main.svml"), "../assets/second.mp4"))?.assetId, "asset_restricted");
});

test("@2 accepts derived lineage but rejects inconsistent licenses and malformed lineage", async () => {
  const root = await mkdtemp(join(tmpdir(), "hypit-studio-assets-"));
  const bytes = Uint8Array.from([8, 8]);
  await writeFile(join(root, "derived.mp4"), bytes);
  const base = entry("asset_derived", "derived.mp4", bytes);
  const manifestPath = join(root, "narralens.assets.json");
  await writeFile(manifestPath, JSON.stringify({ format: "narralens.asset-manifest@2", assets: [{ ...base,
    source: { kind: "derived", label: "composite", lineage: [digest("input")] } }] }));
  const manifest = await loadStudioAssetManifest(manifestPath, root);
  assert.equal((await (await manifest.current()).resolve("asset_derived")).assetId, "asset_derived");
  await writeFile(manifestPath, JSON.stringify({ format: "narralens.asset-manifest@2", assets: [{ ...base,
    source: { kind: "derived", label: "composite", lineage: ["bad"] } }] }));
  await assert.rejects(manifest.current(), StudioAssetRejected);
});

test("manifest parsing matches the runtime schema for asset ids and v1 license semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "hypit-studio-assets-"));
  const bytes = Uint8Array.from([7, 7]);
  await writeFile(join(root, "clip.mp4"), bytes);
  const manifestPath = join(root, "narralens.assets.json");
  const v1ClearedNonCommercial = { ...entry("asset_valid", "clip.mp4", bytes),
    license: { status: "cleared", label: "legacy declaration", commercial_use: false } };
  await writeFile(manifestPath, JSON.stringify({ format: "narralens.asset-manifest@1", assets: [v1ClearedNonCommercial] }));
  const manifest = await loadStudioAssetManifest(manifestPath, root);
  await assert.rejects((await manifest.current()).resolve("asset_valid"), StudioAssetRejected,
    "schema-valid v1 inventory remains ineligible as a mutation target");

  await writeFile(manifestPath, JSON.stringify({ format: "narralens.asset-manifest@1", assets: [
    entry("INVALID", "clip.mp4", bytes),
  ] }));
  await assert.rejects(manifest.current(), StudioAssetRejected);
});
