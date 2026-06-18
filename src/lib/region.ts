/**
 * Pure logic for scaffolding a region config for the
 * [`OpusPopuli/opuspopuli-regions`](https://github.com/OpusPopuli/opuspopuli-regions)
 * repo.
 *
 * Region configs are declarative JSON files validated against
 * `schema/region-plugin.schema.json` in that repo. This module mirrors the
 * subset of that schema we generate, builds a `RegionPluginFile` object from
 * wizard answers, computes the canonical on-disk path, and re-checks the same
 * invariants the regions repo's `pnpm test` enforces — so a freshly scaffolded
 * file lands green rather than bouncing off CI.
 *
 * Everything here is side-effect free and unit tested. The interactive shell
 * and filesystem writes live in `src/commands/region.ts`.
 */

/** `dataType` values the regions schema accepts on a data source. */
export const DATA_TYPES = [
  'propositions',
  'meetings',
  'representatives',
  'campaign_finance',
  'lobbying',
  'civics',
  'bills',
] as const;
export type DataType = (typeof DATA_TYPES)[number];

/** `sourceType` values the regions schema accepts on a data source. */
export const SOURCE_TYPES = [
  'html_scrape',
  'bulk_download',
  'api',
  'pdf',
  'pdf_archive',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** The two region levels this scaffolder authors. `federal` is a singleton that
 *  already exists in the regions repo, so it is intentionally not offered. */
export type RegionLevel = 'state' | 'county';

export interface DataSourceInput {
  url: string;
  dataType: DataType;
  sourceType: SourceType;
  contentGoal: string;
  category?: string;
  hints?: string[];
}

export interface RegionInput {
  level: RegionLevel;
  /** kebab-case; for a county this is the combined `state-county` id. */
  regionId: string;
  displayName: string;
  regionName: string;
  description: string;
  /** semver, e.g. `0.1.0`. */
  version: string;
  /** IANA tz, e.g. `America/Los_Angeles`. */
  timezone: string;
  /** Two-letter US state code, uppercase. */
  stateCode: string;
  /** 2 digits for a state, 5 digits for a county. */
  fipsCode: string;
  /** kebab-case parent state id; required for counties, omitted for states. */
  parentRegionId?: string;
  dataSources: DataSourceInput[];
}

interface DeclarativeRegionConfig {
  regionId: string;
  regionName: string;
  description: string;
  timezone: string;
  stateCode?: string;
  parentRegionId?: string;
  fipsCode?: string;
  dataSources: DataSourceInput[];
}

export interface RegionPluginFile {
  name: string;
  displayName: string;
  description: string;
  version: string;
  config: DeclarativeRegionConfig;
}

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const STATE_CODE_RE = /^[A-Z]{2}$/;

/** Lower-cases, strips accents, and collapses anything non-alphanumeric into
 *  single hyphens — turning "Los Angeles County" into "los-angeles". */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isValidSlug(v: string): boolean {
  return SLUG_RE.test(v);
}

export function isValidStateCode(v: string): boolean {
  return STATE_CODE_RE.test(v);
}

/** A state FIPS is exactly 2 digits; a county FIPS is exactly 5 (state prefix +
 *  3-digit county). */
export function isValidFips(v: string, level: RegionLevel): boolean {
  return level === 'state' ? /^\d{2}$/.test(v) : /^\d{5}$/.test(v);
}

/** Set of IANA zone names on this runtime, or `null` if the host VM doesn't
 *  expose `Intl.supportedValuesOf` (in which case callers should skip the
 *  membership check rather than reject everything). */
function supportedTimeZones(): Set<string> | null {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: string) => string[];
  };
  if (typeof intl.supportedValuesOf !== 'function') return null;
  try {
    return new Set(intl.supportedValuesOf('timeZone'));
  } catch {
    return null;
  }
}

export function isValidTimezone(v: string): boolean {
  if (!v.includes('/')) return false;
  const zones = supportedTimeZones();
  // If the runtime can't enumerate zones, fall back to a shape check so we
  // don't reject a perfectly good "Region/City" string.
  return zones ? zones.has(v) : true;
}

/**
 * Build the `RegionPluginFile` object from collected input. Optional config
 * fields are only set when present so the JSON stays minimal and we don't trip
 * the schema's `additionalProperties: false` / `exactOptionalPropertyTypes`.
 */
export function buildRegionConfig(input: RegionInput): RegionPluginFile {
  const config: DeclarativeRegionConfig = {
    // The regions repo requires `name === config.regionId`; we tie them
    // together at construction so they can never drift.
    regionId: input.regionId,
    regionName: input.regionName,
    description: input.description,
    timezone: input.timezone,
    stateCode: input.stateCode,
    fipsCode: input.fipsCode,
    dataSources: input.dataSources.map(normalizeDataSource),
  };
  if (input.parentRegionId) {
    config.parentRegionId = input.parentRegionId;
  }

  return {
    name: input.regionId,
    displayName: input.displayName,
    description: input.description,
    version: input.version,
    config,
  };
}

function normalizeDataSource(src: DataSourceInput): DataSourceInput {
  const out: DataSourceInput = {
    url: src.url,
    dataType: src.dataType,
    sourceType: src.sourceType,
    contentGoal: src.contentGoal,
  };
  if (src.category) out.category = src.category;
  if (src.hints && src.hints.length > 0) out.hints = src.hints;
  return out;
}

/**
 * Canonical path of a region file inside the regions repo, relative to the repo
 * root:
 *   state  → `regions/<state>/<state>.json`
 *   county → `regions/<state>/counties/<county>/<county>.json`
 *
 * The county slug is the trailing segment of the combined `state-county` id.
 */
export function regionFilePath(input: {
  level: RegionLevel;
  regionId: string;
  parentRegionId?: string;
}): string {
  if (input.level === 'state') {
    return `regions/${input.regionId}/${input.regionId}.json`;
  }
  const parent = input.parentRegionId ?? '';
  // "california-alameda" with parent "california" → county slug "alameda".
  const countySlug = input.regionId.startsWith(`${parent}-`)
    ? input.regionId.slice(parent.length + 1)
    : input.regionId;
  return `regions/${parent}/counties/${countySlug}/${countySlug}.json`;
}

/**
 * Re-check the invariants the regions repo enforces in CI, returning a list of
 * human-readable problems (empty means valid). This is a guard against
 * generating a file that would fail `pnpm test` once dropped into the repo.
 */
export function validateRegionConfig(file: RegionPluginFile): string[] {
  const issues: string[] = [];
  const { config } = file;

  if (file.name !== config.regionId) {
    issues.push(`name "${file.name}" must equal config.regionId "${config.regionId}"`);
  }
  if (!SEMVER_RE.test(file.version)) {
    issues.push(`version "${file.version}" is not a valid semver (expected MAJOR.MINOR.PATCH)`);
  }
  if (!isValidSlug(config.regionId)) {
    issues.push(`regionId "${config.regionId}" must be kebab-case`);
  }
  if (config.stateCode !== undefined && !isValidStateCode(config.stateCode)) {
    issues.push(`stateCode "${config.stateCode}" must be two uppercase letters`);
  }

  const isCounty = config.parentRegionId !== undefined;
  if (config.fipsCode !== undefined) {
    const expected = isCounty ? 5 : 2;
    if (!/^\d+$/.test(config.fipsCode) || config.fipsCode.length !== expected) {
      issues.push(
        `fipsCode "${config.fipsCode}" must be ${expected} digits for a ${isCounty ? 'county' : 'state'}`,
      );
    } else if (
      isCounty &&
      config.parentRegionId &&
      !config.regionId.startsWith(`${config.parentRegionId}-`)
    ) {
      issues.push(
        `county regionId "${config.regionId}" should be prefixed with its parent "${config.parentRegionId}-"`,
      );
    }
  }

  if (config.dataSources.length === 0) {
    issues.push('at least one data source is required');
  }
  const seen = new Set<string>();
  for (const src of config.dataSources) {
    const key = `${src.dataType} ${src.url}`;
    if (seen.has(key)) {
      issues.push(`duplicate data source: ${src.dataType} ${src.url}`);
    }
    seen.add(key);
    if (!/^https?:\/\//.test(src.url)) {
      issues.push(`data source url "${src.url}" must be an http(s) URL`);
    }
  }

  return issues;
}
