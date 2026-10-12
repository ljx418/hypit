import { parseSourceHeader, maskSourceHeader } from "@hypit/hypit/source/text";
import {
  discoverMarkup,
  parseStructuredElement,
  skipTextTrivia,
  type MarkupAttributeValue,
  type StructuredElement,
} from "@hypit/hypit/markup";

import type { StudioAsset, StudioAssetManifest } from "./asset-manifest.js";
import type { Range, StudioSnapshot } from "./shared.js";

export type SourcePatch = {
  readonly path: string;
  readonly range: Range;
  readonly replacement: string;
  readonly preimage: string;
};

type ParsedSource = {
  readonly text: string;
  readonly topLevel: readonly StructuredElement[];
  readonly elements: readonly StructuredElement[];
};

function allElements(element: StructuredElement): readonly StructuredElement[] {
  return [element, ...element.children.flatMap((child) => child.kind === "element" ? allElements(child) : [])];
}

function parseSource(path: string, text: string): ParsedSource {
  const header = parseSourceHeader(path, text);
  const masked = maskSourceHeader(text, header);
  const source = { name: path, text: masked };
  const discovery = discoverMarkup(source);
  const topLevel: StructuredElement[] = [];
  let cursor = discovery.bodyStart;
  while (cursor < masked.length) {
    cursor = skipTextTrivia(source, cursor);
    if (masked.startsWith("</svml", cursor)) break;
    const parsed = parseStructuredElement(source, cursor);
    topLevel.push(parsed.element);
    cursor = parsed.nextOffset;
  }
  return { text, topLevel, elements: topLevel.flatMap(allElements) };
}

function stringAttribute(element: StructuredElement, name: string): string | undefined {
  const value = element.attributes[name];
  return typeof value === "string" ? value : undefined;
}

function referenceAttribute(element: StructuredElement, name: string): string | undefined {
  const value = element.attributes[name];
  return typeof value === "object" && value.kind === "reference" ? value.path : undefined;
}

function uniqueElement(parsed: ParsedSource, name: string, id: string): StructuredElement | undefined {
  const found = parsed.elements.filter((element) => element.name === name && stringAttribute(element, "id") === id);
  if (found.length > 1) throw new Error(`Authored ${name} ${id} is ambiguous.`);
  return found[0];
}

function localBinding(path: string, output?: string): string | undefined {
  const parts = path.split(".");
  if (parts.length !== (output === undefined ? 1 : 2) || (output !== undefined && parts[1] !== output)) return undefined;
  return parts[0];
}

type Binding = {
  readonly clip: StructuredElement;
  readonly normalize: StructuredElement;
  readonly video: StructuredElement;
  readonly normalizeId: string;
  readonly videoId: string;
  readonly locator: string;
};

function bindingFor(parsed: ParsedSource, authoredId: string): Binding | undefined {
  const clip = uniqueElement(parsed, "visual:Clip", authoredId);
  if (clip === undefined) return undefined;
  const normalizeId = localBinding(referenceAttribute(clip, "media") ?? "", "media");
  if (normalizeId === undefined) return undefined;
  const normalize = uniqueElement(parsed, "mediaop:Normalize", normalizeId);
  if (normalize === undefined) return undefined;
  const videoId = localBinding(referenceAttribute(normalize, "source") ?? "");
  if (videoId === undefined) return undefined;
  const video = uniqueElement(parsed, "media:Video", videoId);
  const locator = video === undefined ? undefined : stringAttribute(video, "src");
  if (video === undefined || locator === undefined) return undefined;
  return { clip, normalize, video, normalizeId, videoId, locator };
}

function references(parsed: ParsedSource, path: string): number {
  return parsed.elements.reduce((count, element) => count + Object.values(element.attributes)
    .filter((value): value is Extract<MarkupAttributeValue, { kind: "reference" }> =>
      typeof value === "object" && value.kind === "reference")
    .filter((value) => value.path === path || value.path.startsWith(`${path}.`)).length, 0);
}

function comparableNormalize(element: StructuredElement): string {
  return JSON.stringify(Object.entries(element.attributes)
    .filter(([name]) => name !== "id" && name !== "source")
    .sort(([left], [right]) => left.localeCompare(right)));
}

function sameCloneTemplate(parsed: ParsedSource, current: Binding): boolean {
  const currentVideo = rewrittenElement(parsed.text, current.video, { id: "__ID__", src: "__SRC__" });
  const currentNormalize = rewrittenElement(parsed.text, current.normalize, { id: "__ID__", source: "{__SOURCE__}" });
  return parsed.elements.filter((element) => element !== current.normalize && element.name === "mediaop:Normalize")
    .some((normalize) => {
      const normalizeId = stringAttribute(normalize, "id");
      const videoId = localBinding(referenceAttribute(normalize, "source") ?? "");
      if (normalizeId === undefined || normalizeId.startsWith("hypit-normalize-") || videoId === undefined) return false;
      const video = uniqueElement(parsed, "media:Video", videoId);
      if (video === undefined) return false;
      try {
        return currentVideo === rewrittenElement(parsed.text, video, { id: "__ID__", src: "__SRC__" })
          && currentNormalize === rewrittenElement(parsed.text, normalize, { id: "__ID__", source: "{__SOURCE__}" });
      } catch { return false; }
    });
}

function encodedAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;");
}

function rewrittenElement(text: string, element: StructuredElement, values: Readonly<Record<string, string>>): string {
  let result = text.slice(element.range.start, element.range.end);
  const replacements = Object.entries(values).map(([name, replacement]) => {
    const range = element.attributeValueRanges?.[name];
    if (range === undefined) throw new Error(`${element.name} has no editable ${name} attribute.`);
    return { start: range.start - element.range.start, end: range.end - element.range.start, replacement };
  }).sort((left, right) => right.start - left.start);
  for (const item of replacements) result = `${result.slice(0, item.start)}${item.replacement}${result.slice(item.end)}`;
  return result;
}

function patch(text: string, path: string, range: Range, replacement: string): SourcePatch {
  return { path, range, replacement, preimage: text.slice(range.start, range.end) };
}

function generatedIds(authoredId: string, sha: string): { readonly video: string; readonly normalize: string } {
  if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/u.test(authoredId)) throw new Error("Authored id cannot form a safe generated binding id.");
  const suffix = `${authoredId}-${sha.slice(0, 12)}`;
  return { video: `hypit-media-${suffix}`, normalize: `hypit-normalize-${suffix}` };
}

async function existingBinding(
  parsed: ParsedSource,
  current: Binding,
  sourcePath: string,
  asset: StudioAsset,
  manifest: StudioAssetManifest,
): Promise<Binding | undefined> {
  for (const normalize of parsed.elements.filter((element) => element.name === "mediaop:Normalize")) {
    if (comparableNormalize(normalize) !== comparableNormalize(current.normalize)) continue;
    const normalizeId = stringAttribute(normalize, "id");
    const videoId = localBinding(referenceAttribute(normalize, "source") ?? "");
    if (normalizeId === undefined || videoId === undefined) continue;
    const video = uniqueElement(parsed, "media:Video", videoId);
    const locator = video === undefined ? undefined : stringAttribute(video, "src");
    if (video === undefined || locator === undefined) continue;
    const identified = await manifest.identifyLocator(sourcePath, locator);
    if (identified?.assetId === asset.assetId) return { clip: current.clip, normalize, video, normalizeId, videoId, locator };
  }
  return undefined;
}

async function cleanupGenerated(
  parsed: ParsedSource,
  current: Binding,
  authoredId: string,
  sourcePath: string,
  manifest: StudioAssetManifest,
): Promise<SourcePatch | undefined> {
  const currentAsset = await manifest.identifyLocator(sourcePath, current.locator);
  if (currentAsset === undefined) return undefined;
  const ids = generatedIds(authoredId, currentAsset.sha256);
  if (current.videoId !== ids.video || current.normalizeId !== ids.normalize
    || references(parsed, `${current.normalizeId}.media`) !== 1
    || references(parsed, current.videoId) !== 1 || !sameCloneTemplate(parsed, current)) return undefined;
  const videoIndex = parsed.topLevel.indexOf(current.video);
  const normalizeIndex = parsed.topLevel.indexOf(current.normalize);
  if (videoIndex < 0 || normalizeIndex !== videoIndex + 1) return undefined;
  const prefixStart = current.video.range.start - 3;
  if (prefixStart < 0 || parsed.text.slice(prefixStart, current.video.range.start) !== "\n  "
    || parsed.text.slice(current.video.range.end, current.normalize.range.start) !== "\n  ") return undefined;
  return patch(parsed.text, sourcePath, { start: prefixStart, end: current.normalize.range.end }, "");
}

export async function planMediaReplacement(input: {
  readonly sourcePath: string;
  readonly sourceText: string;
  readonly authoredId: string;
  readonly asset: StudioAsset;
  readonly manifest: StudioAssetManifest;
}): Promise<readonly SourcePatch[]> {
  const parsed = parseSource(input.sourcePath, input.sourceText);
  const current = bindingFor(parsed, input.authoredId);
  if (current === undefined) throw new Error(`Item ${input.authoredId} has no supported local video binding.`);
  const currentAsset = await input.manifest.identifyLocator(input.sourcePath, current.locator);
  if (currentAsset?.assetId === input.asset.assetId) return [];
  const target = await existingBinding(parsed, current, input.sourcePath, input.asset, input.manifest);
  const mediaRange = current.clip.attributeValueRanges?.media;
  if (mediaRange === undefined) throw new Error(`Item ${input.authoredId} has no exact media reference range.`);
  const result: SourcePatch[] = [];
  if (target !== undefined) {
    result.push(patch(parsed.text, input.sourcePath, mediaRange, `{${target.normalizeId}.media}`));
    const cleanup = await cleanupGenerated(parsed, current, input.authoredId, input.sourcePath, input.manifest);
    if (current.normalizeId.startsWith(`hypit-normalize-${input.authoredId}-`) && cleanup === undefined) {
      throw new Error("The previous generated media binding cannot be safely cleaned up.");
    }
    if (cleanup !== undefined) result.push(cleanup);
    return result;
  }
  const locator = input.manifest.locator(input.sourcePath, input.asset);
  const currentGenerated = current.normalizeId.startsWith(`hypit-normalize-${input.authoredId}-`);
  if (!currentGenerated && references(parsed, `${current.normalizeId}.media`) === 1 && references(parsed, current.videoId) === 1) {
    const srcRange = current.video.attributeValueRanges?.src;
    if (srcRange === undefined) throw new Error("The current video has no exact src range.");
    return [patch(parsed.text, input.sourcePath, srcRange, encodedAttribute(locator))];
  }
  const ids = generatedIds(input.authoredId, input.asset.sha256);
  if (parsed.elements.some((element) => stringAttribute(element, "id") === ids.video || stringAttribute(element, "id") === ids.normalize)) {
    throw new Error("Generated media binding identity collides with authored Source.");
  }
  const video = rewrittenElement(parsed.text, current.video, { id: encodedAttribute(ids.video), src: encodedAttribute(locator) });
  const normalize = rewrittenElement(parsed.text, current.normalize, { id: encodedAttribute(ids.normalize), source: `{${ids.video}}` });
  result.push(patch(parsed.text, input.sourcePath, { start: current.normalize.range.end, end: current.normalize.range.end }, `\n  ${video}\n  ${normalize}`));
  result.push(patch(parsed.text, input.sourcePath, mediaRange, `{${ids.normalize}.media}`));
  if (currentGenerated) {
    const cleanup = await cleanupGenerated(parsed, current, input.authoredId, input.sourcePath, input.manifest);
    if (cleanup === undefined) throw new Error("The previous generated media binding cannot be safely cleaned up.");
    result.push(cleanup);
  }
  return result;
}

export async function projectMediaAssets(
  snapshot: StudioSnapshot,
  sourcePath: string,
  manifest: StudioAssetManifest,
): Promise<StudioSnapshot> {
  const parsed = parseSource(sourcePath, snapshot.source.text);
  const tracks = await Promise.all(snapshot.tracks.map(async (track) => ({
    ...track,
    items: await Promise.all(track.items.map(async (item) => {
      const binding = bindingFor(parsed, item.authoredId);
      if (binding === undefined) return item;
      const asset = await manifest.identifyLocator(sourcePath, binding.locator);
      return asset === undefined ? item : { ...item, mediaAsset: { assetId: asset.assetId, sha256: asset.sha256 } };
    })),
  })));
  return { ...snapshot, tracks };
}
