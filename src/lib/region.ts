/**
 * Pure logic for scaffolding a region config for the
 * [`OpusPopuli/opuspopuli-regions`](https://github.com/OpusPopuli/opuspopuli-regions)
 * repo.
 *
 * Region configs are declarative JSON files validated against
 * `schema/region-plugin.schema.json` in that repo. We vendor a copy of that
 * schema at `./region-schema.json` so the wizard is self-contained and
 * validates against the **canonical contract** rather than a hand-rolled
 * approximation. Anything the schema enforces is enforced here; we layer a
 * small set of cross-field invariants on top that the regions repo's
 * `pnpm test` also checks (e.g. `name === config.regionId`).
 *
 * Everything here is side-effect free and unit tested. The interactive shell
 * and filesystem writes live in `src/commands/region.ts`.
 */

// ESM-native JSON Schema validator. Picked over Ajv 8 because Ajv ships only
// CJS, which forces a `.default` interop dance under `verbatimModuleSyntax`.
// `@cfworker/json-schema` is a clean ESM module with no peer dep and supports
// the Draft 7 / 2019-09 / 2020-12 schemas the regions repo uses.
import { Validator, type Schema } from '@cfworker/json-schema';

// Schema imported as JSON so tsup inlines it into the bundle — no need to
// ship a separate file in dist/.
import REGION_SCHEMA from './region-schema.json' with { type: 'json' };

/** `dataType` values the regions schema accepts on a data source. Mirrors the
 *  enum block in `region-plugin.schema.json` so the CLI prompt matches. */
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
}

export interface RegionInput {
  level: RegionLevel;
  /** kebab-case; for a county this is the combined `state-county` id. */
  regionId: string;
  /** kebab-case county slug only — the trailing segment of a county regionId.
   *  Required for counties so we never have to re-derive it from string
   *  prefixes; ignored for states. */
  countySlug?: string;
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
const STATE_CODE_RE = /^[A-Z]{2}$/;

/** Lower-cases, strips accents, and collapses anything non-alphanumeric into
 *  single hyphens — turning "Los Angeles County" into "los-angeles". */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    // The collapse above leaves at most a single hyphen at each edge, so a
    // quantifier-free `^-|-$` trim is equivalent to `^-+|-+$` and can't
    // backtrack super-linearly.
    .replace(/^-|-$/g, '');
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
  return out;
}

/**
 * Canonical path of a region file inside the regions repo, relative to the repo
 * root:
 *   state  → `regions/<state>/<state>.json`
 *   county → `regions/<state>/counties/<county>/<county>.json`
 *
 * Counties pass `countySlug` explicitly so we never have to back out a slug
 * from a string prefix — important when a parent state slug contains a hyphen
 * (`new-jersey-cumberland` shouldn't be sliced on the first `-`).
 */
export function regionFilePath(input: {
  level: RegionLevel;
  regionId: string;
  parentRegionId?: string;
  countySlug?: string;
}): string {
  if (input.level === 'state') {
    return `regions/${input.regionId}/${input.regionId}.json`;
  }
  const parent = input.parentRegionId;
  const countySlug = input.countySlug;
  if (!parent || !countySlug) {
    throw new Error(
      'regionFilePath: county requires both parentRegionId and countySlug',
    );
  }
  return `regions/${parent}/counties/${countySlug}/${countySlug}.json`;
}

// ---------------------------------------------------------------------------
// Schema-based validation (single source of truth)
// ---------------------------------------------------------------------------

// The JSON import resolves to a narrower literal type than `Schema` accepts
// (e.g. `type: "object"` as a string literal vs the union enum). The cast is
// a TS-only widening — runtime data is unchanged.
const schemaValidator = new Validator(REGION_SCHEMA as unknown as Schema, '7');

/**
 * Re-check the invariants the regions repo enforces in CI, returning a list of
 * human-readable problems (empty means valid). Two layers:
 *
 * 1. **JSON Schema** — run the vendored `region-plugin.schema.json` (the same
 *    file `pnpm test` validates against). Catches every structural rule the
 *    schema declares.
 * 2. **Cross-field invariants** — checks the regions repo enforces in custom
 *    test code that don't live in the schema: `name === config.regionId`,
 *    county regionId prefixed by its parent, no duplicate data sources keyed by
 *    `(dataType, url)`.
 */
export function validateRegionConfig(file: RegionPluginFile): string[] {
  // Cross-field invariants run first so their human-friendlier messages
  // ("not a valid semver", "must be 5 digits for a county", "name mismatch")
  // surface ahead of the corresponding raw Ajv pattern errors. Order of the
  // groups here IS the order issues are reported in.
  return [
    ...validateVersionAndIds(file),
    ...validateFipsCode(file),
    ...validateDataSourceUniqueness(file),
    ...validateAgainstSchema(file),
  ];
}

// version semver + name/regionId agreement + kebab-case + county prefix.
function validateVersionAndIds(file: RegionPluginFile): string[] {
  const issues: string[] = [];
  const { config } = file;
  if (!/^\d+\.\d+\.\d+$/.test(file.version)) {
    issues.push(`version "${file.version}" is not a valid semver (expected MAJOR.MINOR.PATCH)`);
  }
  if (file.name !== config.regionId) {
    issues.push(`name "${file.name}" must equal config.regionId "${config.regionId}"`);
  }
  if (!isValidSlug(config.regionId)) {
    issues.push(`regionId "${config.regionId}" must be kebab-case`);
  }
  if (
    config.parentRegionId !== undefined &&
    !config.regionId.startsWith(`${config.parentRegionId}-`)
  ) {
    issues.push(
      `county regionId "${config.regionId}" should be prefixed with its parent "${config.parentRegionId}-"`,
    );
  }
  return issues;
}

// The JSON schema only checks the FIPS shape (2–7 digits). Per-level lengths
// ("2 for state, 5 for county") are a cross-field rule the regions repo
// enforces in custom test code — re-checked here.
function validateFipsCode(file: RegionPluginFile): string[] {
  const { config } = file;
  if (config.fipsCode === undefined) return [];
  const isCounty = config.parentRegionId !== undefined;
  const expected = isCounty ? 5 : 2;
  if (!/^\d+$/.test(config.fipsCode) || config.fipsCode.length !== expected) {
    return [
      `fipsCode "${config.fipsCode}" must be ${expected} digits for a ${isCounty ? 'county' : 'state'}`,
    ];
  }
  return [];
}

// dataSources is required by the schema — if it's missing the schema layer
// below will flag that, so we just skip the duplicate scan here rather than
// throwing on a malformed-but-not-yet-validated file.
function validateDataSourceUniqueness(file: RegionPluginFile): string[] {
  const { config } = file;
  if (!Array.isArray(config.dataSources)) return [];
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const src of config.dataSources) {
    const key = `${src.dataType} ${src.url}`;
    if (seen.has(key)) {
      issues.push(`duplicate data source: ${src.dataType} ${src.url}`);
    }
    seen.add(key);
  }
  return issues;
}

// Layer the schema on last — catches anything the friendly checks didn't
// pre-empt (missing required fields, wrong types, unknown extras, etc.).
function validateAgainstSchema(file: RegionPluginFile): string[] {
  const result = schemaValidator.validate(file);
  if (result.valid) return [];
  return result.errors.map((err) => `schema: ${err.instanceLocation || '<root>'} ${err.error}`);
}
