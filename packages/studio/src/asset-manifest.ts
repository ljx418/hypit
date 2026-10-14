import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const manifestLimit = 1024 * 1024;
const assetLimit = 256;
const stringLimit = 2048;
const digestPattern = /^[a-f0-9]{64}$/u;
const assetIdPattern = /^asset_[a-z0-9][a-z0-9_-]{0,63}$/u;

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

export type StudioAssetManifestView = {
  readonly sha256: string;
  readonly path: string;
  readonly resolve: (assetId: string) => Promise<StudioAsset>;
  readonly identifyLocator: (sourcePath: string, locator: string) => Promise<StudioAsset | undefined>;
  readonly locator: (sourcePath: string, asset: StudioAsset) => string;
};

export type StudioAssetManifestLease = StudioAssetManifestView & {
  readonly assertCurrent: () => Promise<void>;
};

export type StudioAssetManifest = {
  /** Startup digest retained for compatibility; mutations must use lease(expected). */
  readonly sha256: string;
  readonly path: string;
  readonly resolve: StudioAssetManifestView["resolve"];
  readonly identifyLocator: StudioAssetManifestView["identifyLocator"];
  readonly locator: StudioAssetManifestView["locator"];
  readonly current: () => Promise<StudioAssetManifestView>;
  readonly lease: (expectedSha256: string) => Promise<StudioAssetManifestLease>;
};

type ManifestEntry = {
  readonly asset_id: string;
  readonly project_path: string;
  readonly sha256: string;
  readonly media_type: "video/mp4";
  readonly kind: "video";
  readonly duration_frames: number;
  readonly source: Readonly<Record<string, unknown>>;
  readonly license: { readonly status: "cleared" | "restricted" | "unknown"; readonly label: string; readonly commercial_use: boolean };
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

function sourceRecord(value: unknown, format: "narralens.asset-manifest@1" | "narralens.asset-manifest@2", assetId: string): Readonly<Record<string, unknown>> {
  const source = object(value, `Asset ${assetId} source`);
  const kind = boundedString(source.kind, `Asset ${assetId} source kind`);
  if (kind === "derived") {
    if (format !== "narralens.asset-manifest@2") throw new StudioAssetRejected(`Asset ${assetId} uses a v2-only source kind.`);
    exactKeys(source, ["kind", "label", "lineage"], `Asset ${assetId} source`);
    boundedString(source.label, `Asset ${assetId} source label`);
    if (!Array.isArray(source.lineage) || source.lineage.length < 1 || source.lineage.length > 64
      || source.lineage.some((item) => typeof item !== "string" || !digestPattern.test(item))
      || new Set(source.lineage).size !== source.lineage.length) {
      throw new StudioAssetRejected(`Asset ${assetId} has invalid source lineage.`);
    }
    return source;
  }
  if (!(["owned", "generated", "licensed"] as const).includes(kind as "owned" | "generated" | "licensed")) {
    throw new StudioAssetRejected(`Asset ${assetId} has an invalid source kind.`);
  }
  const sourceKeys = Object.hasOwn(source, "uri") ? ["kind", "label", "uri"] : ["kind", "label"];
  exactKeys(source, sourceKeys, `Asset ${assetId} source`);
  boundedString(source.label, `Asset ${assetId} source label`);
  if (source.uri !== undefined) {
    const uri = boundedString(source.uri, `Asset ${assetId} source uri`);
    try { new URL(uri); } catch { throw new StudioAssetRejected(`Asset ${assetId} has an invalid source uri.`); }
  }
  return source;
}

function parseManifest(text: string): readonly ManifestEntry[] {
  if (Buffer.byteLength(text) > manifestLimit) throw new StudioAssetRejected("Asset manifest exceeds 1 MiB.");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new StudioAssetRejected("Asset manifest is not valid JSON."); }
  const root = object(raw, "Asset manifest");
  exactKeys(root, ["format", "assets"], "Asset manifest");
  const format = root.format;
  if ((format !== "narralens.asset-manifest@1" && format !== "narralens.asset-manifest@2")
    || !Array.isArray(root.assets) || root.assets.length === 0 || root.assets.length > assetLimit) {
    throw new StudioAssetRejected("Asset manifest has an unsupported format or size.");
  }
  const seen = new Set<string>();
  return root.assets.map((value, index): ManifestEntry => {
    const entry = object(value, `Asset ${index}`);
    exactKeys(entry, ["asset_id", "project_path", "sha256", "media_type", "kind", "duration_frames", "source", "license"], `Asset ${index}`);
    const assetId = boundedString(entry.asset_id, `Asset ${index} id`);
    if (!assetIdPattern.test(assetId)) throw new StudioAssetRejected(`Asset ${index} has an invalid asset id.`);
    if (!/^asset_[a-z0-9][a-z0-9_-]{0,63}$/u.test(assetId) || seen.has(assetId)) throw new StudioAssetRejected(`Asset ${index} has an invalid or duplicate id.`);
    seen.add(assetId);
    const projectPath = boundedString(entry.project_path, `Asset ${index} path`);
    if (isAbsolute(projectPath) || projectPath.split(/[\\/]/u).includes("..")) throw new StudioAssetRejected(`Asset ${assetId} must use a contained project path.`);
    const digest = boundedString(entry.sha256, `Asset ${assetId} sha256`);
    if (!digestPattern.test(digest)) throw new StudioAssetRejected(`Asset ${assetId} has an invalid sha256.`);
    if (entry.media_type !== "video/mp4" || entry.kind !== "video"
      || !Number.isSafeInteger(entry.duration_frames) || (entry.duration_frames as number) < 1) {
      throw new StudioAssetRejected(`Asset ${assetId} is not a supported video.`);
    }
    const source = sourceRecord(entry.source, format, assetId);
    const license = object(entry.license, `Asset ${assetId} license`);
    exactKeys(license, ["status", "label", "commercial_use"], `Asset ${assetId} license`);
    const status = boundedString(license.status, `Asset ${assetId} license status`);
    if (status !== "cleared" && status !== "restricted" && status !== "unknown") throw new StudioAssetRejected(`Asset ${assetId} has an invalid license status.`);
    boundedString(license.label, `Asset ${assetId} license label`);
    if (typeof license.commercial_use !== "boolean") throw new StudioAssetRejected(`Asset ${assetId} has an invalid commercial-use declaration.`);
    if (format === "narralens.asset-manifest@2" && status === "cleared" && license.commercial_use !== true) {
      throw new StudioAssetRejected(`Asset ${assetId} has an inconsistent cleared license.`);
    }
    if (source.kind === "derived" && (status !== "cleared" || license.commercial_use !== true)) {
      throw new StudioAssetRejected(`Derived asset ${assetId} must be cleared for commercial use.`);
    }
    return { asset_id: assetId, project_path: projectPath, sha256: digest, media_type: "video/mp4", kind: "video",
      duration_frames: entry.duration_frames as number, source,
      license: { status, label: license.label as string, commercial_use: license.commercial_use } };
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

  const readView = async (expectedSha256?: string): Promise<StudioAssetManifestLease> => {
    const text = await readFile(canonicalManifest, "utf8");
    const manifestSha256 = sha256(text);
    if (expectedSha256 !== undefined && manifestSha256 !== expectedSha256) {
      throw new StudioAssetManifestChanged("Asset manifest changed outside Studio.");
    }
    const entries = parseManifest(text);
    const byId = new Map(entries.map((entry) => [entry.asset_id, entry]));
    const assertCurrent = async (): Promise<void> => {
      const current = await readFile(canonicalManifest, "utf8");
      if (sha256(current) !== manifestSha256) throw new StudioAssetManifestChanged("Asset manifest changed outside Studio.");
    };
    const resolveEntry = async (entry: ManifestEntry, requireEligible: boolean): Promise<StudioAsset> => {
      await assertCurrent();
      if (requireEligible && (entry.license.status !== "cleared" || entry.license.commercial_use !== true)) {
        throw new StudioAssetRejected(`Asset ${entry.asset_id} is not cleared for Studio mutation.`);
      }
      const candidate = await realpath(resolve(canonicalRoot, entry.project_path));
      if (!contained(canonicalRoot, candidate)) throw new StudioAssetRejected(`Asset ${entry.asset_id} escaped the workspace.`);
      const bytes = await readFile(candidate);
      if (sha256(bytes) !== entry.sha256) throw new StudioAssetRejected(`Asset ${entry.asset_id} bytes do not match the manifest.`);
      await assertCurrent();
      return { assetId: entry.asset_id, projectPath: entry.project_path, absolutePath: candidate,
        sha256: entry.sha256, mediaType: "video/mp4", durationFrames: entry.duration_frames };
    };
    return {
      sha256: manifestSha256,
      path: canonicalManifest,
      assertCurrent,
      async resolve(assetId) {
        const entry = byId.get(assetId);
        if (entry === undefined) throw new StudioAssetRejected(`Unknown Studio asset ${assetId}.`);
        return await resolveEntry(entry, true);
      },
      async identifyLocator(sourcePath, locator) {
        await assertCurrent();
        if (isAbsolute(locator)) return undefined;
        let canonical: string;
        try { canonical = await realpath(resolve(dirname(sourcePath), locator)); } catch { return undefined; }
        for (const entry of entries) {
          let candidate: string;
          try { candidate = await realpath(resolve(canonicalRoot, entry.project_path)); } catch { continue; }
          if (candidate === canonical) return await resolveEntry(entry, false);
        }
        return undefined;
      },
      locator(sourcePath, asset) {
        const value = relative(dirname(sourcePath), asset.absolutePath).split(sep).join("/");
        return value.startsWith(".") ? value : `./${value}`;
      },
    };
  };

  const startup = await readView();
  return {
    sha256: startup.sha256,
    path: canonicalManifest,
    resolve: async (assetId) => await (await readView()).resolve(assetId),
    identifyLocator: async (sourcePath, locator) => await (await readView()).identifyLocator(sourcePath, locator),
    locator: (sourcePath, asset) => startup.locator(sourcePath, asset),
    current: async () => await readView(),
    lease: async (expectedSha256) => {
      if (!digestPattern.test(expectedSha256)) throw new StudioAssetManifestChanged("Expected asset manifest sha256 is invalid.");
      return await readView(expectedSha256);
    },
  };
}
