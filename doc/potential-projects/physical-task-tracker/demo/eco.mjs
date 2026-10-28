// eco.mjs — ecology fusion: open weather + soil data as optimizer input.
// Sources (no keys needed): Open-Meteo forecast API, SoilGrids v2 REST.
//   node eco.mjs <lat,lon> [--out samples/eco-x.json]
//
// Emits { location, fetched_at, weather, soil, constraints }: weather is a
// 3-day field-work summary, soil is topsoil texture/organic-matter/pH, and
// constraints are hard optimizer strings ("never spray before rain", ...).
// Thresholds are exported for tests. Node 18+ (global fetch).

export const RAIN_PROB_PCT = 60; // precipitation_probability_max worth planning around
export const HEAT_C = 35; // suspend midday transplant / irrigate early
export const FROST_C = 0; // overnight cover-seedlings risk
export const WIND_KMH = 40; // spray-drift cutoff
export const SANDY_PCT = 60; // short irrigation cycles below this sand share
export const CLAYEY_PCT = 40; // compaction risk above this clay share
// Note: organic matter stays in the summary block as soft guidance — it
// informs the model but never vetoes an action the way rain/frost/pH do.

const WMO = {
  0: 'clear', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'rime fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 71: 'light snow', 73: 'snow',
  75: 'heavy snow', 80: 'light showers', 81: 'showers', 82: 'violent showers',
  95: 'thunderstorm', 96: 'storm + hail', 99: 'storm + heavy hail',
};

export function wmoText(code) {
  return WMO[code] ?? `code ${code}`;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ECO ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// --- Open-Meteo: current + 3-day daily vectors, keyed by day index.
export async function fetchWeather(lat, lon) {
  const q = new URLSearchParams({
    latitude: String(lat), longitude: String(lon),
    current: 'temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max',
    timezone: 'auto', forecast_days: '3',
  });
  return getJson(`https://api.open-meteo.com/v1/forecast?${q}`);
}

// --- SoilGrids v2: topsoil (0-5cm) means for texture, organic carbon, pH.
export async function fetchSoil(lat, lon) {
  const q = new URLSearchParams({ lon: String(lon), lat: String(lat), depth: '0-5cm', value: 'mean' });
  for (const p of ['sand', 'clay', 'soc', 'phh2o']) q.append('property', p);
  return getJson(`https://rest.soilgrids.org/soilgrids/v2.0/properties/query?${q}`);
}

// Normalize one SoilGrids layer to physical units. Handles both documented
// unit_measure spellings ({conversion_factor} and {d_factor}).
export function soilLayerMean(layer) {
  const depth = layer?.depths?.find((d) => d.label === '0-5cm') ?? layer?.depths?.[0];
  const raw = depth?.values?.mean;
  if (!Number.isFinite(raw)) return null;
  const factor = layer?.unit_measure?.conversion_factor ?? layer?.unit_measure?.d_factor ?? 1;
  return raw / factor;
}

export function normalizeSoil(doc) {
  const layers = doc?.properties?.layers ?? doc?.layers ?? [];
  const byName = Object.fromEntries(layers.map((l) => [l.name, soilLayerMean(l)]));
  // sand/clay/soc arrive deci-units (g/kg / dg/kg ÷ 10); phh2o arrives pH×10.
  return {
    sand_pct: byName.sand ?? null, // g/kg ÷ 10 → %
    clay_pct: byName.clay ?? null,
    soc_gkg: byName.soc != null ? byName.soc / 10 : null, // dg/kg → g/kg
    ph: byName.phh2o ?? null,
  };
}

// --- Signals → hard optimizer constraints + prompt summary block.
export function ecoConstraints(weather, soil) {
  const out = [];
  const days = weather?.daily?.time ?? [];
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const at = (k) => weather.daily?.[k]?.[i];
    if ((at('precipitation_probability_max') ?? 0) >= RAIN_PROB_PCT)
      out.push(`Rain likely ${day} (${at('precipitation_probability_max')}%): no spraying or tillage; move shippable harvest first`);
    if ((at('temperature_2m_max') ?? -99) >= HEAT_C)
      out.push(`Heat ${at('temperature_2m_max')}°C ${day}: no midday transplant; irrigate early morning`);
    if ((at('temperature_2m_min') ?? 99) <= FROST_C)
      out.push(`Frost risk ${day} (${at('temperature_2m_min')}°C): cover seedlings, delay transplant`);
    if ((at('wind_speed_10m_max') ?? 0) >= WIND_KMH)
      out.push(`High wind ${at('wind_speed_10m_max')} km/h ${day}: no spraying (drift risk)`);
  }
  if ((soil?.sand_pct ?? 0) >= SANDY_PCT)
    out.push(`Sandy topsoil (~${Math.round(soil.sand_pct)}% sand): irrigate in short cycles; nitrogen leaches fast`);
  if ((soil?.clay_pct ?? 0) >= CLAYEY_PCT)
    out.push(`Heavy clay (~${Math.round(soil.clay_pct)}% clay): never work soil wet (compaction)`);
  if (soil?.ph != null && (soil.ph < 5.5 || soil.ph > 7.8))
    out.push(`Topsoil pH ${soil.ph.toFixed(1)} outside 5.5–7.8: check nutrient lockout before fertilizing`);
  return out;
}

export function summarizeEco(weather, soil, lat, lon) {
  const c = weather?.current;
  const now = c
    ? `${c.temperature_2m}°C, ${wmoText(c.weather_code)}, RH ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} km/h`
    : 'current conditions unavailable';
  const days = weather?.daily?.time ?? [];
  const ahead = days
    .map((d, i) => {
      const g = (k) => weather.daily?.[k]?.[i];
      return `${d}: ${g('temperature_2m_min')}–${g('temperature_2m_max')}°C, rain ${g('precipitation_probability_max')}% (${g('precipitation_sum')}mm), wind ${g('wind_speed_10m_max')} km/h`;
    })
    .join('; ');
  const dirt =
    soil?.sand_pct != null
      ? `topsoil sand ~${Math.round(soil.sand_pct)}%, clay ~${Math.round(soil.clay_pct ?? NaN)}%, organic matter ${soil.soc_gkg?.toFixed(1) ?? '?'} g/kg, pH ${soil.ph?.toFixed(1) ?? '?'}`
      : 'soil data unavailable';
  return `Site (${lat}, ${lon}). Now: ${now}. Next 3 days: ${ahead || 'unavailable'}. Soil: ${dirt}.`;
}

export async function fetchEco(lat, lon) {
  const [weather, soilDoc] = await Promise.all([fetchWeather(lat, lon), fetchSoil(lat, lon)]);
  const soil = normalizeSoil(soilDoc);
  return {
    location: { lat, lon },
    fetched_at: new Date().toISOString(),
    weather,
    soil,
    constraints: ecoConstraints(weather, soil),
    summary: summarizeEco(weather, soil, lat, lon),
  };
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const [ll, outFlag, outPath] = process.argv.slice(2);
  if (!ll?.includes(',')) {
    console.error('Usage: node eco.mjs <lat,lon> [--out samples/eco-x.json]');
    process.exit(2);
  }
  try {
    const [lat, lon] = ll.split(',').map(Number);
    const eco = await fetchEco(lat, lon);
    const text = JSON.stringify(eco, null, 2);
    if (outFlag === '--out' && outPath) {
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, text + '\n');
      console.error(`wrote ${outPath} (${eco.constraints.length} constraints)`);
    }
    console.log(text);
  } catch (err) {
    console.error(`eco failed: ${err.message}`);
    process.exit(1);
  }
}
