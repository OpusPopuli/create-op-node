import { describe, expect, it } from 'vitest';

import {
  buildRegionConfig,
  isValidFips,
  isValidStateCode,
  isValidTimezone,
  regionFilePath,
  slugify,
  validateRegionConfig,
  type RegionInput,
} from '../src/lib/region.js';

function stateInput(overrides: Partial<RegionInput> = {}): RegionInput {
  return {
    level: 'state',
    regionId: 'california',
    displayName: 'California',
    regionName: 'California',
    description: 'Civic data for the state of California',
    version: '0.1.0',
    timezone: 'America/Los_Angeles',
    stateCode: 'CA',
    fipsCode: '06',
    dataSources: [
      {
        url: 'https://leginfo.legislature.ca.gov/',
        dataType: 'bills',
        sourceType: 'html_scrape',
        contentGoal: 'Fetch active state bills',
      },
    ],
    ...overrides,
  };
}

function countyInput(overrides: Partial<RegionInput> = {}): RegionInput {
  return {
    level: 'county',
    regionId: 'california-alameda',
    countySlug: 'alameda',
    parentRegionId: 'california',
    displayName: 'Alameda County',
    regionName: 'Alameda County',
    description: 'Civic data for Alameda County',
    version: '0.1.0',
    timezone: 'America/Los_Angeles',
    stateCode: 'CA',
    fipsCode: '06001',
    dataSources: [
      {
        url: 'https://acgov.org/board/',
        dataType: 'meetings',
        sourceType: 'html_scrape',
        contentGoal: 'Fetch Board of Supervisors meetings',
        category: 'Board of Supervisors',
      },
    ],
    ...overrides,
  };
}

describe('slugify', () => {
  it('kebab-cases names and strips accents/punctuation', () => {
    expect(slugify('California')).toBe('california');
    expect(slugify('Los Angeles County')).toBe('los-angeles-county');
    expect(slugify('Doña Ana')).toBe('dona-ana');
    expect(slugify('  St. Louis  ')).toBe('st-louis');
  });
});

describe('validators', () => {
  it('validates state codes', () => {
    expect(isValidStateCode('CA')).toBe(true);
    expect(isValidStateCode('ca')).toBe(false);
    expect(isValidStateCode('CAL')).toBe(false);
  });

  it('enforces FIPS length per level', () => {
    expect(isValidFips('06', 'state')).toBe(true);
    expect(isValidFips('006', 'state')).toBe(false);
    expect(isValidFips('06001', 'county')).toBe(true);
    expect(isValidFips('601', 'county')).toBe(false);
  });

  it('accepts well-formed IANA zones and rejects junk', () => {
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('NotAZone')).toBe(false);
  });
});

describe('buildRegionConfig', () => {
  it('ties name to config.regionId and omits parentRegionId for states', () => {
    const file = buildRegionConfig(stateInput());
    expect(file.name).toBe('california');
    expect(file.config.regionId).toBe('california');
    expect(file.name).toBe(file.config.regionId);
    expect(file.config.parentRegionId).toBeUndefined();
    expect(file.config.fipsCode).toBe('06');
  });

  it('sets parentRegionId and combined id for counties', () => {
    const file = buildRegionConfig(countyInput());
    expect(file.name).toBe('california-alameda');
    expect(file.config.parentRegionId).toBe('california');
  });

  it('drops empty optional fields on data sources', () => {
    const file = buildRegionConfig(stateInput());
    const src = file.config.dataSources[0]!;
    expect('category' in src).toBe(false);
  });
});

describe('regionFilePath', () => {
  it('computes the state path', () => {
    expect(regionFilePath({ level: 'state', regionId: 'california' })).toBe(
      'regions/california/california.json',
    );
  });

  it('computes the county path from explicit countySlug', () => {
    expect(
      regionFilePath({
        level: 'county',
        regionId: 'california-alameda',
        parentRegionId: 'california',
        countySlug: 'alameda',
      }),
    ).toBe('regions/california/counties/alameda/alameda.json');
  });

  it('handles hyphenated parent slugs without string-slicing ambiguity', () => {
    // "new-jersey-cumberland" prefix-matches both "new" and "new-jersey";
    // passing the explicit countySlug avoids guessing.
    expect(
      regionFilePath({
        level: 'county',
        regionId: 'new-jersey-cumberland',
        parentRegionId: 'new-jersey',
        countySlug: 'cumberland',
      }),
    ).toBe('regions/new-jersey/counties/cumberland/cumberland.json');
  });

  it('throws if a county is missing parentRegionId or countySlug', () => {
    expect(() =>
      regionFilePath({ level: 'county', regionId: 'california-alameda' }),
    ).toThrow(/parentRegionId and countySlug/);
  });
});

describe('validateRegionConfig', () => {
  it('passes a well-formed state config', () => {
    expect(validateRegionConfig(buildRegionConfig(stateInput()))).toEqual([]);
  });

  it('passes a well-formed county config', () => {
    expect(validateRegionConfig(buildRegionConfig(countyInput()))).toEqual([]);
  });

  it('flags a name/regionId mismatch', () => {
    const file = buildRegionConfig(stateInput());
    file.name = 'oregon';
    const issues = validateRegionConfig(file);
    expect(issues.some((i) => i.includes('must equal config.regionId'))).toBe(true);
  });

  it('flags a non-semver version', () => {
    const issues = validateRegionConfig(buildRegionConfig(stateInput({ version: '1.0' })));
    expect(issues.some((i) => i.includes('semver'))).toBe(true);
  });

  it('flags duplicate data sources', () => {
    const dup = stateInput();
    dup.dataSources = [dup.dataSources[0]!, { ...dup.dataSources[0]! }];
    const issues = validateRegionConfig(buildRegionConfig(dup));
    expect(issues.some((i) => i.includes('duplicate data source'))).toBe(true);
  });

  it('flags a county FIPS of the wrong length', () => {
    const issues = validateRegionConfig(buildRegionConfig(countyInput({ fipsCode: '06' })));
    expect(issues.some((i) => i.includes('5 digits for a county'))).toBe(true);
  });

  it('flags a county id not prefixed by its parent', () => {
    const issues = validateRegionConfig(
      buildRegionConfig(countyInput({ regionId: 'alameda' })),
    );
    expect(issues.some((i) => i.includes('prefixed with its parent'))).toBe(true);
  });

  it('catches schema-only violations the friendly checks would miss', () => {
    // Add an unknown top-level field. The schema has `additionalProperties:
    // false`, so this should be rejected by the JSON Schema layer — none of
    // the cross-field rules cover unknown extras.
    const file = buildRegionConfig(stateInput());
    (file as Record<string, unknown>).someExtraField = 'not in the schema';
    const issues = validateRegionConfig(file);
    expect(issues.some((i) => i.startsWith('schema:'))).toBe(true);
  });
});
