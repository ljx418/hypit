import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const manifestLimit = 1024 * 1024;
const assetLimit = 256;
const stringLimit = 2048;

export type StudioAsset = {
  readonly assetId: string;
  readonly projectPath: string;
  readonly absolutePath: string;
  readonly sha256: string;
  readonly mediaType: "video/mp4";
  readonly durationFrames: number;
};

export class StudioAssetRejected extends Error {}
export class StudioAssetManifestChanged extends Error {}

export type StudioAssetManifest = {
  readonly sha256: string;
  readonly path: string;
  readonly resolve: (assetId: string) => Promise<StudioAsset>;
  readonly identifyLocator: (sourcePath: string, locator: string) => Promise<StudioAsset | undefined>;
  readonly locator: (sourcePath: string, asset: StudioAsset) => string;
};

type ManifestEntry = {
  readonly asset_id: string;
  readonly project_path: string;
  readonly sha256: string;
  readonly media_type: string;
  readonly kind: string;
  readonly duration_frames: number;
  readonly source: { readonly kind: string; readonly label: string; readonly uri?: string };
  readonly license: { readonly status: string; readonly label: string; readonly commercial_use: boolean };
};

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new StudioAssetRejected(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const keys = Object.keys(value);
  const unexpected = keys.find((key) => !expected.includes(key));
  const missing = expected.find((key) => !Object.hasOwn(value, key));
  if (unexpected !== undefined || missing !== undefined) throw new StudioAssetRejected(`${label} has an invalid field set.`);
}

function boundedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > stringLimit) throw new StudioAssetRejected(`${label} must be bounded text.`);
  return value;
}

function parseManifest(text: string): readonly ManifestEntry[] {
  if (Buffer.byteLength(text) > manifestLimit) throw new StudioAssetRejected("Asset manifest exceeds 1 MiB.");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new StudioAssetRejected("Asset manifest is not valid JSON."); }
  const root = object(raw, "Asset manifest");
  exactKeys(root, ["format", "assets"], "Asset manifest");
  if (root.format !== "narralens.asset-manifest@1" || !Array.isArray(root.assets)
    || root.assets.length === 0 || root.assets.length > assetLimit) throw new StudioAssetRejected("Asset manifest has an unsupported format or size.");
  const seen = new Set<string>();
  return root.assets.map((value, index): ManifestEntry => {
    const entry = object(value, `Asset ${index}`);
    exactKeys(entry, ["asset_id", "project_path", "sha256", "media_type", "kind", "duration_frames", "source", "license"], `Asset ${index}`);
    const assetId = boundedString(entry.asset_id, `Asset ${index} id`);
    if (!/^asset_[a-z0-9][a-z0-9_-]{0,63}$/u.test(assetId) || seen.has(assetId)) throw new StudioAssetRejected(`Asset ${index} has an invalid or duplicate id.`);
    seen.add(assetId);
    const projectPath = boundedString(entry.project_path, `Asset ${index} path`);
    if (isAbsolute(projectPath) || projectPath.split(/[\\/]/u).includes("..")) throw new StudioAssetRejected(`Asset ${assetId} must use a contained project path.`);
    const digest = boundedString(entry.sha256, `Asset ${assetId} sha256`);
    if (!/^[a-f0-9]{64}$/u.test(digest)) throw new StudioAssetRejected(`Asset ${assetId} has an invalid sha256.`);
    if (entry.media_type !== "video/mp4" || entry.kind !== "video"
      || !Number.isSafeInteger(entry.duration_frames) || (entry.duration_frames as number) < 1) {
      throw new StudioAssetRejected(`Asset ${assetId} is not a supported video.`);
    }
    const source = object(entry.source, `Asset ${assetId} source`);
    const sourceKeys = Object.hasOwn(source, "uri") ? ["kind", "label", "uri"] : ["kind", "label"];
    exactKeys(source, sourceKeys, `Asset ${assetId} source`);
    if (!["owned", "generated", "licensed"].includes(boundedString(source.kind, `Asset ${assetId} source kind`))) throw new StudioAssetRejected(`Asset ${assetId} has an invalid source kind.`);
    boundedString(source.label, `Asset ${assetId} source label`);
    if (source.uri !== undefined) boundedString(source.uri, `Asset ${assetId} source uri`);
    const license = object(entry.license, `Asset ${assetId} license`);
    exactKeys(license, ["status", "label", "commercial_use"], `Asset ${assetId} license`);
    boundedString(license.label, `Asset ${assetId} license label`);
    if (license.status !== "cleared" || license.commercial_use !== true) throw new StudioAssetRejected(`Asset ${assetId} is not cleared for D4.0 use.`);
    return { asset_id: assetId, project_path: projectPath, sha256: digest, media_type: "video/mp4", kind: "video",
      duration_frames: entry.duration_frames as number,
      source: source as ManifestEntry["source"], license: license as ManifestEntry["license"] };
  });
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function loadStudioAssetManifest(path: string, workspaceRoot: string): Promise<StudioAssetManifest> {
  const canonicalRoot = await realpath(workspaceRoot);
  const canonicalManifest = await realpath(path);
  if (!contained(canonicalRoot, canonicalManifest)) throw new StudioAssetRejected("Asset manifest is outside the workspace.");
  const startupText = await readFile(canonicalManifest, "utf8");
  const startupSha = sha256(startupText);
  const entries = parseManifest(startupText);
  const byId = new Map(entries.map((entry) => [entry.asset_id, entry]));

  const assertManifestUnchanged = async (): Promise<void> => {
    const current = await readFile(canonicalManifest, "utf8");
    if (sha256(current) !== startupSha) throw new StudioAssetManifestChanged("Asset manifest changed outside Studio.");
  };
  const resolveEntry = async (entry: ManifestEntry): Promise<StudioAsset> => {
    await assertManifestUnchanged();
    const candidate = await realpath(resolve(canonicalRoot, entry.project_path));
    if (!contained(canonicalRoot, candidate)) throw new StudioAssetRejected(`Asset ${entry.asset_id} escaped the workspace.`);
    const bytes = await readFile(candidate);
    if (sha256(bytes) !== entry.sha256) throw new StudioAssetRejected(`Asset ${entry.asset_id} bytes do not match the manifest.`);
    return { assetId: entry.asset_id, projectPath: entry.project_path, absolutePath: candidate,
      sha256: entry.sha256, mediaType: "video/mp4", durationFrames: entry.duration_frames };
  };
  return {
    sha256: startupSha,
    path: canonicalManifest,
    async resolve(assetId) {
      const entry = byId.get(assetId);
      if (entry === undefined) throw new StudioAssetRejected(`Unknown Studio asset ${assetId}.`);
      return await resolveEntry(entry);
    },
    async identifyLocator(sourcePath, locator) {
      await assertManifestUnchanged();
      if (isAbsolute(locator)) return undefined;
      let canonical: string;
      try { canonical = await realpath(resolve(dirname(sourcePath), locator)); } catch { return undefined; }
      for (const entry of entries) {
        const candidate = await realpath(resolve(canonicalRoot, entry.project_path));
        if (candidate === canonical) return await resolveEntry(entry);
      }
      return undefined;
    },
    locator(sourcePath, asset) {
      const value = relative(dirname(sourcePath), asset.absolutePath).split(sep).join("/");
      return value.startsWith(".") ? value : `./${value}`;
    },
  };
}
