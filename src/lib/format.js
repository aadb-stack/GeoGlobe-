// Value formatting + small data helpers shared across the app.

export function formatValue(value, format) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  switch (format) {
    case 'usdB': // value is in USD billions
      if (value >= 1000) return `$${(value / 1000).toFixed(2)}T`;
      if (value >= 1) return `$${value.toFixed(value >= 100 ? 0 : 1)}B`;
      return `$${(value * 1000).toFixed(0)}M`;
    case 'usd':
      return `$${Math.round(value).toLocaleString('en-US')}`;
    case 'millions': // value is in millions of people
      if (value >= 1000) return `${(value / 1000).toFixed(2)}B`;
      if (value >= 1) return `${value.toFixed(1)}M`;
      return `${Math.round(value * 1_000_000).toLocaleString('en-US')}`;
    case 'hdi':
      return value.toFixed(3);
    case 'rank':
      return `#${value}`;
    case 'pct':
      return `${value.toFixed(1)}%`;
    case 'km2':
      return `${Math.round(value).toLocaleString('en-US')} km²`;
    default:
      return String(value);
  }
}

// Population density people / km²
export function density(country) {
  if (!country.population || !country.area) return null;
  return (country.population * 1_000_000) / country.area;
}

// Resolve the 3-letter code for a geojson feature, tolerating the few polygons
// whose ISO_A3 is the Natural Earth "-99" sentinel.
export function featureCode(props) {
  const iso = props.ISO_A3;
  if (iso && iso !== '-99') return iso;
  return props.ADM0_A3 || props.ISO_A3_EH || null;
}

export function featureName(props) {
  return props.ADMIN || props.NAME || props.NAME_LONG || 'Unknown';
}

// Merge curated data with whatever the geojson can supply as a fallback so that
// every clickable polygon shows *something*.
export function buildProfile(props, curated) {
  const code = featureCode(props);
  if (curated) {
    return { code, curated: true, ...curated };
  }
  // Fallback profile derived purely from Natural Earth attributes.
  const popEst = Number(props.POP_EST) || null;
  const gdpMdEst = Number(props.GDP_MD_EST) || null; // GDP in USD millions
  return {
    code,
    curated: false,
    name: featureName(props),
    flag: codeToFlag(props.ISO_A2),
    capital: null,
    region: props.CONTINENT || props.REGION_UN || null,
    gov: null,
    currency: null,
    gdp: gdpMdEst ? gdpMdEst / 1000 : null, // -> USD billions
    gdpPerCapita: gdpMdEst && popEst ? (gdpMdEst * 1_000_000) / popEst : null,
    population: popEst ? popEst / 1_000_000 : null,
    hdi: null,
    militaryRank: null,
    inflation: null,
    area: null,
    incomeGroup: props.INCOME_GRP || null,
    economy: props.ECONOMY || null,
  };
}

// Convert a 2-letter ISO country code into its flag emoji.
export function codeToFlag(iso2) {
  if (!iso2 || iso2.length !== 2 || iso2 === '-99') return '🏳️';
  const A = 0x1f1e6;
  const chars = iso2.toUpperCase().split('').map((c) => A + (c.charCodeAt(0) - 65));
  return String.fromCodePoint(...chars);
}
