import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadStudioAssetManifest } from "../src/asset-manifest.js";
import { planMediaReplacement, projectMediaAssets, type SourcePatch } from "../src/media-binding-editor.js";
import type { StudioSnapshot } from "../src/shared.js";

const source = `<?svml using="@hypit/markup@1"?>
<svml>
  <import as="media" from="@hypit/media@1"/>
  <import as="mediaop" from="@hypit/media-operations@1"/>
  <import as="visual" from="@hypit/visual-track@1"/>

  <media:Video id="visual-source" src="../assets/baseline.mp4"/>
  <mediaop:Normalize id="visual-media" source={visual-source}
    video="primary-moving" audio="none" span-authority="video" clock={clock}/>
  <visual:Track id="picture" timeline={program.timeline}>
    <visual:Clip id="shot-1" media={visual-media.media} during={program.shot-1}/>
    <visual:Clip id="shot-2" media={visual-media.media} during={program.shot-2}/>
    <visual:Clip id="shot-3" media={visual-media.media} during={program.shot-3}/>
  </visual:Track>
</svml>
`;

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function apply(text: string, patches: readonly SourcePatch[]): string {
  let next = text;
  for (const item of [...patches].sort((left, right) => right.range.start - left.range.start)) {
    assert.equal(next.slice(item.range.start, item.range.end), item.preimage);
    next = `${next.slice(0, item.range.start)}${item.replacement}${next.slice(item.range.end)}`;
  }
  return next;
}

async function fixture(): Promise<{ root: string; sourcePath: string; manifest: Awaited<ReturnType<typeof loadStudioAssetManifest>> }> {
  const root = await mkdtemp(join(tmpdir(), "hypit-media-binding-"));
  await mkdir(join(root, "assets")); await mkdir(join(root, "authors"));
  const baseline = Uint8Array.from([1, 1, 1]); const alt = Uint8Array.from([2, 2, 2]); const third = Uint8Array.from([3, 3, 3]);
  await writeFile(join(root, "assets", "baseline.mp4"), baseline);
  await writeFile(join(root, "assets", "alt.mp4"), alt);
  await writeFile(join(root, "assets", "third.mp4"), third);
  const sourcePath = join(root, "authors", "main.svml"); await writeFile(sourcePath, source);
  const manifestPath = join(root, "narralens.assets.json");
  await writeFile(manifestPath, JSON.stringify({ format: "narralens.asset-manifest@1", assets: [
    { asset_id: "asset_baseline", project_path: "assets/baseline.mp4", sha256: digest(baseline), media_type: "video/mp4", kind: "video", duration_frames: 300,
      source: { kind: "generated", label: "baseline" }, license: { status: "cleared", label: "test", commercial_use: true } },
    { asset_id: "asset_alt", project_path: "assets/alt.mp4", sha256: digest(alt), media_type: "video/mp4", kind: "video", duration_frames: 300,
      source: { kind: "generated", label: "alt" }, license: { status: "cleared", label: "test", commercial_use: true } },
    { asset_id: "asset_third", project_path: "assets/third.mp4", sha256: digest(third), media_type: "video/mp4", kind: "video", duration_frames: 300,
      source: { kind: "generated", label: "third" }, license: { status: "cleared", label: "test", commercial_use: true } },
  ] }));
  return { root, sourcePath, manifest: await loadStudioAssetManifest(manifestPath, root) };
}

test("shared media binding is isolated and a normal replacement restores exact source bytes", async () => {
  const held = await fixture();
  const alt = await held.manifest.resolve("asset_alt");
  const changed = apply(source, await planMediaReplacement({ sourcePath: held.sourcePath, sourceText: source,
    authoredId: "shot-2", asset: alt, manifest: held.manifest }));
  assert.match(changed, /hypit-media-shot-2-/u);
  assert.match(changed, /id="shot-1" media=\{visual-media\.media\}/u);
  assert.match(changed, /id="shot-3" media=\{visual-media\.media\}/u);
  assert.match(changed, /id="shot-2" media=\{hypit-normalize-shot-2-/u);
  const baseline = await held.manifest.resolve("asset_baseline");
  const restored = apply(changed, await planMediaReplacement({ sourcePath: held.sourcePath, sourceText: changed,
    authoredId: "shot-2", asset: baseline, manifest: held.manifest }));
  assert.equal(restored, source);
});

test("a modified generated binding is never deleted as an editor-owned clone", async () => {
  const held = await fixture();
  const alt = await held.manifest.resolve("asset_alt");
  const changed = apply(source, await planMediaReplacement({ sourcePath: held.sourcePath, sourceText: source,
    authoredId: "shot-2", asset: alt, manifest: held.manifest }));
  const tampered = changed.replace(/(<mediaop:Normalize id="hypit-normalize-shot-2-[^"]+"[^>]*span-authority=")video(")/u, "$1audio$2");
  assert.notEqual(tampered, changed);
  const baseline = await held.manifest.resolve("asset_baseline");
  await assert.rejects(planMediaReplacement({ sourcePath: held.sourcePath, sourceText: tampered,
    authoredId: "shot-2", asset: baseline, manifest: held.manifest }), /cannot be safely cleaned up/u);
});

test("switching between generated assets removes only the old clone and is text-stable", async () => {
  const held = await fixture();
  const alt = await held.manifest.resolve("asset_alt");
  const firstAlt = apply(source, await planMediaReplacement({ sourcePath: held.sourcePath, sourceText: source,
    authoredId: "shot-2", asset: alt, manifest: held.manifest }));
  const third = await held.manifest.resolve("asset_third");
  const thirdText = apply(firstAlt, await planMediaReplacement({ sourcePath: held.sourcePath, sourceText: firstAlt,
    authoredId: "shot-2", asset: third, manifest: held.manifest }));
  assert.equal(thirdText.match(/<media:Video id="hypit-media-shot-2-/gu)?.length, 1);
  const secondAlt = apply(thirdText, await planMediaReplacement({ sourcePath: held.sourcePath, sourceText: thirdText,
    authoredId: "shot-2", asset: alt, manifest: held.manifest }));
  assert.equal(secondAlt, firstAlt);
});

test("session projection exposes only opaque manifest asset identity", async () => {
  const held = await fixture();
  const item = (id: string) => ({ id: `picture:${id}`, authoredId: id, presentId: id, display: { title: id, layers: [] },
    startFrame: 0, endFrameExclusive: 10, stackOrder: 1, presentation: { family: "visual", tone: "neutral", label: "Visual", icon: "video" },
    renderIds: [], inspector: [], editHandles: [] });
  const snapshot = { revision: 1, source: { path: "authors/main.svml", text: source, files: [] },
    run: { path: "runs/build.svrun", targets: [], satisfactions: [] }, canvas: { width: 1, height: 1, clearColor: "#000" },
    timeline: { frameRate: { numerator: 30, denominator: 1 }, frameCount: 30, durationSec: 1 },
    tracks: [{ id: "picture", label: "Visual", row: 0, items: [item("shot-1"), item("shot-2"), item("shot-3")], inspectorObjects: [],
      binding: { family: "visual", tone: "neutral", facet: "visual", groupId: "picture", icon: "video", companion: "test", lane: { kind: "primary" }, references: [] },
      provenance: { output: "picture", origin: "source", status: "resolved", errors: [] } }], temporalDomains: [],
    preview: { kind: "html-program", srcdoc: "" }, provenance: { picture: "resolved", note: "test" } } as unknown as StudioSnapshot;
  const projected = await projectMediaAssets(snapshot, held.sourcePath, held.manifest);
  assert.deepEqual(projected.tracks[0]!.items.map((entry) => entry.mediaAsset?.assetId), ["asset_baseline", "asset_baseline", "asset_baseline"]);
  assert.equal(JSON.stringify(projected).includes(held.root), false);
});
