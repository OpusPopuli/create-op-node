import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { Command, Option } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';

import {
  DATA_TYPES,
  SOURCE_TYPES,
  buildRegionConfig,
  isValidFips,
  isValidSlug,
  isValidStateCode,
  isValidTimezone,
  regionFilePath,
  slugify,
  validateRegionConfig,
  type DataSourceInput,
  type DataType,
  type RegionInput,
  type RegionLevel,
  type RegionPluginFile,
  type SourceType,
} from '../lib/region.js';
import { unwrap } from '../lib/prompts.js';

interface RegionOptions {
  level?: string;
  name?: string;
  parent?: string;
  stateCode?: string;
  fips?: string;
  timezone?: string;
  outDir?: string;
  force?: boolean;
}

export const regionCommand = new Command('region')
  .description(
    'Scaffold a schema-valid region config for the OpusPopuli/opuspopuli-regions repo. ' +
      'Run this from inside your checkout of that repo.',
  )
  .addOption(
    new Option('--level <level>', 'Region level').choices(['state', 'county']),
  )
  .addOption(new Option('--name <name>', 'Region name (e.g. "California" or "Alameda")'))
  .addOption(
    new Option('--parent <slug>', 'Parent state slug for a county (e.g. california)'),
  )
  .addOption(new Option('--state-code <code>', 'Two-letter US state code (e.g. CA)'))
  .addOption(new Option('--fips <code>', 'FIPS code (2 digits state, 5 digits county)'))
  .addOption(new Option('--timezone <tz>', 'IANA timezone (e.g. America/Los_Angeles)'))
  .addOption(
    new Option('--out-dir <dir>', 'Repo root to write under').default(
      process.cwd(),
      'current directory',
    ),
  )
  .addOption(new Option('-f, --force', 'Overwrite an existing config file').default(false))
  .action(async (opts: RegionOptions) => {
    p.intro(pc.bgMagenta(pc.black(' create-op-node region ')));
    printRegionWelcome();

    const targetDir = await resolveTargetDir(opts);
    const level = await resolveLevel(opts);
    const identity = await collectIdentity(opts, level);
    const codes = await collectCodes(opts, level);
    const dataSources = await collectDataSources();

    const input = buildRegionInput({ level, identity, codes, dataSources });
    const file = buildAndValidateConfig(input);
    await writeRegionConfig({ opts, targetDir, level, identity, file });
  });

// ----------------------------------------------------------------------------
// Region wizard steps
// ----------------------------------------------------------------------------
// The action delegates to these so no single function exceeds the
// cognitive-complexity budget. Behavior-preserving: prompts, validation, and
// process.exit calls are relocated verbatim.

interface RegionIdentity {
  rawName: string;
  parentSlug: string | undefined;
  ownSlug: string;
  regionId: string;
  regionName: string;
  description: string;
}

interface RegionCodes {
  stateCode: string;
  fipsCode: string;
  timezone: string;
}

const requireNonEmpty = (v: string | undefined): string | undefined =>
  v && v.trim().length > 0 ? undefined : 'Required';

function printRegionWelcome(): void {
  p.note(
    [
      'Scaffolds a declarative region config JSON for opuspopuli-regions —',
      'the file that defines WHAT civic data a region collects.',
      '',
      pc.dim('Run this from the root of your opuspopuli-regions checkout.'),
      pc.dim('It validates the same invariants the repo’s `pnpm test` enforces,'),
      pc.dim('so the file lands green and you just commit + open a PR.'),
    ].join('\n'),
    'Welcome',
  );
}

// ---- Step 0: sanity-check we're inside an opuspopuli-regions checkout ----
async function resolveTargetDir(opts: RegionOptions): Promise<string> {
  const targetDir = opts.outDir ?? process.cwd();
  const looksRight = await looksLikeRegionsRepo(targetDir);
  if (!looksRight) {
    const proceed = unwrap(
      await p.confirm({
        message: `${targetDir} doesn't look like an opuspopuli-regions checkout (no schema/region-plugin.schema.json). Continue anyway?`,
        initialValue: false,
      }),
    );
    if (!proceed) {
      p.cancel('Cancelled — run again from your opuspopuli-regions checkout, or pass --out-dir.');
      process.exit(0);
    }
  }
  return targetDir;
}

// ---- Step 1: level ----
async function resolveLevel(opts: RegionOptions): Promise<RegionLevel> {
  return opts.level === 'state' || opts.level === 'county'
    ? opts.level
    : unwrap(
        await p.select({
          message: 'What level is this region?',
          options: [
            { value: 'state', label: 'State', hint: 'e.g. California' },
            { value: 'county', label: 'County', hint: 'e.g. Alameda, within California' },
          ],
        }),
      );
}

// Parent state slug — only prompted for counties.
async function resolveParentSlug(opts: RegionOptions, level: RegionLevel): Promise<string | undefined> {
  if (level !== 'county') return undefined;
  const parentSlug =
    opts.parent ??
    unwrap(
      await p.text({
        message: 'Parent state slug?',
        placeholder: 'california',
        validate: (v) =>
          isValidSlug(v ?? '') ? undefined : 'kebab-case (lowercase letters, digits, hyphens)',
      }),
    );
  if (!isValidSlug(parentSlug)) {
    p.cancel(`Parent slug "${parentSlug}" must be kebab-case.`);
    process.exit(1);
  }
  return parentSlug;
}

// ---- Step 2: identity (name, slug, parent, display, description) ----
async function collectIdentity(opts: RegionOptions, level: RegionLevel): Promise<RegionIdentity> {
  const rawName =
    opts.name ??
    unwrap(
      await p.text({
        message: level === 'county' ? 'County name?' : 'State name?',
        placeholder: level === 'county' ? 'Alameda' : 'California',
        validate: requireNonEmpty,
      }),
    );

  const parentSlug = await resolveParentSlug(opts, level);

  const ownSlug = slugify(rawName);
  const regionId = level === 'county' ? `${parentSlug}-${ownSlug}` : ownSlug;
  if (!isValidSlug(regionId)) {
    p.cancel(`Derived regionId "${regionId}" is not valid kebab-case. Try a simpler name.`);
    process.exit(1);
  }

  const displayName = unwrap(
    await p.text({
      message: 'Display name?',
      defaultValue: rawName,
    }),
  );
  const regionName = displayName || rawName;

  const description = unwrap(
    await p.text({
      message: 'One-line description of the data coverage?',
      placeholder:
        level === 'county'
          ? `Civic data for ${rawName} County`
          : `Civic data for the state of ${rawName}`,
      validate: requireNonEmpty,
    }),
  );

  return { rawName, parentSlug, ownSlug, regionId, regionName, description };
}

// ---- Step 3: codes (state code, FIPS, timezone) ----
async function collectCodes(opts: RegionOptions, level: RegionLevel): Promise<RegionCodes> {
  const stateCode = (
    opts.stateCode ??
    unwrap(
      await p.text({
        message: 'Two-letter state code?',
        placeholder: 'CA',
        validate: (v) =>
          isValidStateCode((v ?? '').toUpperCase()) ? undefined : 'Two letters, e.g. CA',
      }),
    )
  ).toUpperCase();
  if (!isValidStateCode(stateCode)) {
    p.cancel(`State code "${stateCode}" must be two letters.`);
    process.exit(1);
  }

  const fipsCode =
    opts.fips ??
    unwrap(
      await p.text({
        message: level === 'county' ? 'County FIPS (5 digits)?' : 'State FIPS (2 digits)?',
        placeholder: level === 'county' ? '06001' : '06',
        validate: (v) => {
          if (isValidFips(v ?? '', level)) return undefined;
          const expectedDigits = level === 'county' ? '5' : '2';
          return `Expected ${expectedDigits} digits`;
        },
      }),
    );
  if (!isValidFips(fipsCode, level)) {
    p.cancel(`FIPS "${fipsCode}" is the wrong length for a ${level}.`);
    process.exit(1);
  }

  const timezone =
    opts.timezone ??
    unwrap(
      await p.text({
        message: 'IANA timezone?',
        defaultValue: 'America/Los_Angeles',
        placeholder: 'America/Los_Angeles',
        validate: (v) =>
          isValidTimezone(v || 'America/Los_Angeles')
            ? undefined
            : 'Not a recognized IANA zone (e.g. America/New_York)',
      }),
    );

  return { stateCode, fipsCode, timezone };
}

// ---- Step 4: at least one data source ----
async function collectOneDataSource(index: number): Promise<DataSourceInput> {
  const url = unwrap(
    await p.text({
      message: `Data source #${index} — URL?`,
      placeholder: 'https://example.gov/meetings',
      validate: (v) => (/^https?:\/\//.test(v ?? '') ? undefined : 'Must start with http(s)://'),
    }),
  );
  const dataType = unwrap(
    await p.select({
      message: 'Data type?',
      options: DATA_TYPES.map((t) => ({ value: t, label: t })),
    }),
  ) as DataType;
  const sourceType = unwrap(
    await p.select({
      message: 'Source type?',
      initialValue: 'html_scrape' as SourceType,
      options: SOURCE_TYPES.map((t) => ({ value: t, label: t })),
    }),
  ) as SourceType;
  const contentGoal = unwrap(
    await p.text({
      message: 'Content goal (what should the scraper extract)?',
      placeholder: 'Fetch upcoming board meeting agendas and minutes',
      validate: requireNonEmpty,
    }),
  );
  const category = unwrap(
    await p.text({
      message: 'Category label (optional)?',
      placeholder: 'Board of Supervisors',
    }),
  );

  const src: DataSourceInput = { url, dataType, sourceType, contentGoal };
  if (category && category.trim().length > 0) src.category = category.trim();
  return src;
}

async function collectDataSources(): Promise<DataSourceInput[]> {
  const dataSources: DataSourceInput[] = [];
  do {
    dataSources.push(await collectOneDataSource(dataSources.length + 1));
    const again = unwrap(
      await p.confirm({ message: 'Add another data source?', initialValue: false }),
    );
    if (!again) break;
    // eslint-disable-next-line no-constant-condition
  } while (true);
  return dataSources;
}

// ---- Step 5: build the RegionInput from the collected answers ----
export function buildRegionInput(args: {
  level: RegionLevel;
  identity: RegionIdentity;
  codes: RegionCodes;
  dataSources: DataSourceInput[];
}): RegionInput {
  const { level, identity, codes, dataSources } = args;
  return {
    level,
    regionId: identity.regionId,
    displayName: identity.regionName,
    regionName: identity.regionName,
    description: identity.description,
    // New region configs start at 0.1.0 — the documented convention in the
    // regions repo's CLAUDE.md. Bump manually as the config matures.
    version: '0.1.0',
    timezone: codes.timezone,
    stateCode: codes.stateCode,
    fipsCode: codes.fipsCode,
    dataSources,
    ...(identity.parentSlug ? { parentRegionId: identity.parentSlug } : {}),
    ...(level === 'county' ? { countySlug: identity.ownSlug } : {}),
  };
}

// Build + validate the config; exits if the generated file would fail CI.
function buildAndValidateConfig(input: RegionInput): RegionPluginFile {
  const file = buildRegionConfig(input);
  const issues = validateRegionConfig(file);
  if (issues.length > 0) {
    p.note(issues.map((i) => `${pc.red('•')} ${i}`).join('\n'), 'Validation failed');
    p.cancel('The generated config would not pass the regions repo CI. Re-run and adjust.');
    process.exit(1);
  }
  return file;
}

// ---- Step 6: preview + write ----
async function writeRegionConfig(args: {
  opts: RegionOptions;
  targetDir: string;
  level: RegionLevel;
  identity: RegionIdentity;
  file: RegionPluginFile;
}): Promise<void> {
  const { opts, targetDir, level, identity, file } = args;
  const relPath = regionFilePath({
    level,
    regionId: identity.regionId,
    ...(identity.parentSlug ? { parentRegionId: identity.parentSlug } : {}),
    ...(level === 'county' ? { countySlug: identity.ownSlug } : {}),
  });
  const absPath = resolve(targetDir, relPath);
  const json = `${JSON.stringify(file, null, 2)}\n`;

  p.note(json, `${relPath} (preview)`);

  if (!opts.force && (await fileExists(absPath))) {
    p.cancel(`${relPath} already exists. Re-run with --force to overwrite.`);
    process.exit(1);
  }

  const write = unwrap(
    await p.confirm({ message: `Write ${relPath}?`, initialValue: true }),
  );
  if (!write) {
    p.cancel('Nothing written.');
    process.exit(0);
  }

  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, json, 'utf8');

  p.note(
    [
      `${pc.green('✓')} Wrote ${pc.cyan(relPath)}`,
      '',
      'Next steps in your opuspopuli-regions checkout:',
      pc.dim('  pnpm test                 # schema + hierarchy validation'),
      pc.dim('  pnpm test:connectivity    # URL reachability (informational)'),
      pc.dim(`  git add ${relPath} && git commit && open a PR`),
    ].join('\n'),
    'Done',
  );
  p.outro(pc.magenta(`Region scaffolded: ${identity.regionId}`));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Heuristic: the regions repo always has `schema/region-plugin.schema.json`
 *  and a top-level `regions/` directory. If both are present we're confident
 *  we're in the right checkout; if neither we warn before writing anywhere. */
async function looksLikeRegionsRepo(dir: string): Promise<boolean> {
  const [hasSchema, hasRegions] = await Promise.all([
    fileExists(join(dir, 'schema', 'region-plugin.schema.json')),
    fileExists(join(dir, 'regions')),
  ]);
  return hasSchema && hasRegions;
}
