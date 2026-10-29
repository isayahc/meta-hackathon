// Ecology fusion: open weather + soil data as optimizer input.
// Sources (no keys needed): Open-Meteo forecast API, SoilGrids v2 REST.
// Doubles as a CLI when run directly:
//   node dist/lib/eco.js <lat,lon> [--out samples/eco-x.json]
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

const WMO: Record<number, string> = {
  0: 'clear', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'rime fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 71: 'light snow', 73: 'snow',
  75: 'heavy snow', 80: 'light showers', 81: 'showers', 82: 'violent showers',
  95: 'thunderstorm', 96: 'storm + hail', 99: 'storm + heavy hail',
};

export function wmoText(code: number): string {
  return WMO[code] ?? `code ${code}`;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ECO ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<unknown>;
}

export interface WeatherDoc {
  current?: {
    temperature_2m?: number;
    relative_humidity_2m?: number;
    precipitation?: number;
    weather_code?: number;
    wind_speed_10m?: number;
  };
  daily?: {
    time?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SoilSummary {
  sand_pct: number | null;
  clay_pct: number | null;
  soc_gkg: number | null;
  ph: number | null;
}

interface SoilLayer {
  name?: string;
  unit_measure?: { conversion_factor?: number; d_factor?: number };
  depths?: Array<{ label?: string; values?: { mean?: number } }>;
}

interface SoilDoc {
  properties?: { layers?: SoilLayer[] };
  layers?: SoilLayer[];
}

// --- Open-Meteo: current + 3-day daily vectors, keyed by day index.
export async function fetchWeather(lat: number, lon: number): Promise<WeatherDoc> {
  const q = new URLSearchParams({
    latitude: String(lat), longitude: String(lon),
    current: 'temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max',
    timezone: 'auto', forecast_days: '3',
  });
  return (await getJson(`https://api.open-meteo.com/v1/forecast?${q}`)) as WeatherDoc;
}

// --- SoilGrids v2: topsoil (0-5cm) means for texture, organic carbon, pH.
export async function fetchSoil(lat: number, lon: number): Promise<SoilDoc> {
  const q = new URLSearchParams({ lon: String(lon), lat: String(lat), depth: '0-5cm', value: 'mean' });
  for (const p of ['sand', 'clay', 'soc', 'phh2o']) q.append('property', p);
  return (await getJson(`https://rest.soilgrids.org/soilgrids/v2.0/properties/query?${q}`)) as SoilDoc;
}

// Normalize one SoilGrids layer to physical units. Handles both documented
// unit_measure spellings ({conversion_factor} and {d_factor}).
export function soilLayerMean(layer: SoilLayer | null | undefined): number | null {
  const depth = layer?.depths?.find((d) => d.label === '0-5cm') ?? layer?.depths?.[0];
  const raw = depth?.values?.mean;
  if (!Number.isFinite(raw)) return null;
  const factor = layer?.unit_measure?.conversion_factor ?? layer?.unit_measure?.d_factor ?? 1;
  return (raw as number) / factor;
}

export function normalizeSoil(doc: SoilDoc | null | undefined): SoilSummary {
  const layers = doc?.properties?.layers ?? doc?.layers ?? [];
  const byName: Record<string, number | null> = Object.fromEntries(
    layers.map((l) => [l.name ?? '', soilLayerMean(l)])
  );
  // sand/clay/soc arrive deci-units (g/kg / dg/kg ÷ 10); phh2o arrives pH×10.
  const soc = byName['soc'];
  return {
    sand_pct: byName['sand'] ?? null, // g/kg ÷ 10 → %
    clay_pct: byName['clay'] ?? null,
    soc_gkg: soc != null ? soc / 10 : null, // dg/kg → g/kg
    ph: byName['phh2o'] ?? null,
  };
}

function dayVal(weather: WeatherDoc, key: string, i: number): number | undefined {
  const v = (weather.daily as Record<string, unknown> | undefined)?.[key];
  return Array.isArray(v) ? (v[i] as number | undefined) : undefined;
}

// --- Signals → hard optimizer constraints + prompt summary block.
export function ecoConstraints(weather: WeatherDoc, soil: SoilSummary): string[] {
  const out: string[] = [];
  const days = weather?.daily?.time ?? [];
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    if ((dayVal(weather, 'precipitation_probability_max', i) ?? 0) >= RAIN_PROB_PCT)
      out.push(`Rain likely ${day} (${dayVal(weather, 'precipitation_probability_max', i)}%): no spraying or tillage; move shippable harvest first`);
    if ((dayVal(weather, 'temperature_2m_max', i) ?? -99) >= HEAT_C)
      out.push(`Heat ${dayVal(weather, 'temperature_2m_max', i)}°C ${day}: no midday transplant; irrigate early morning`);
    if ((dayVal(weather, 'temperature_2m_min', i) ?? 99) <= FROST_C)
      out.push(`Frost risk ${day} (${dayVal(weather, 'temperature_2m_min', i)}°C): cover seedlings, delay transplant`);
    if ((dayVal(weather, 'wind_speed_10m_max', i) ?? 0) >= WIND_KMH)
      out.push(`High wind ${dayVal(weather, 'wind_speed_10m_max', i)} km/h ${day}: no spraying (drift risk)`);
  }
  if ((soil?.sand_pct ?? 0) >= SANDY_PCT)
    out.push(`Sandy topsoil (~${Math.round(soil.sand_pct as number)}% sand): irrigate in short cycles; nitrogen leaches fast`);
  if ((soil?.clay_pct ?? 0) >= CLAYEY_PCT)
    out.push(`Heavy clay (~${Math.round(soil.clay_pct as number)}% clay): never work soil wet (compaction)`);
  if (soil?.ph != null && (soil.ph < 5.5 || soil.ph > 7.8))
    out.push(`Topsoil pH ${soil.ph.toFixed(1)} outside 5.5–7.8: check nutrient lockout before fertilizing`);
  return out;
}

export function summarizeEco(weather: WeatherDoc, soil: SoilSummary, lat: number, lon: number): string {
  const c = weather?.current;
  const now = c
    ? `${c.temperature_2m}°C, ${wmoText(c.weather_code as number)}, RH ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} km/h`
    : 'current conditions unavailable';
  const days = weather?.daily?.time ?? [];
  const ahead = days
    .map((d, i) => {
      return `${d}: ${dayVal(weather, 'temperature_2m_min', i)}–${dayVal(weather, 'temperature_2m_max', i)}°C, rain ${dayVal(weather, 'precipitation_probability_max', i)}% (${dayVal(weather, 'precipitation_sum', i)}mm), wind ${dayVal(weather, 'wind_speed_10m_max', i)} km/h`;
    })
    .join('; ');
  const dirt =
    soil?.sand_pct != null
      ? `topsoil sand ~${Math.round(soil.sand_pct)}%, clay ~${Math.round(soil.clay_pct ?? NaN)}%, organic matter ${soil.soc_gkg?.toFixed(1) ?? '?'} g/kg, pH ${soil.ph?.toFixed(1) ?? '?'}`
      : 'soil data unavailable';
  return `Site (${lat}, ${lon}). Now: ${now}. Next 3 days: ${ahead || 'unavailable'}. Soil: ${dirt}.`;
}

export interface EcoReport {
  location: { lat: number; lon: number };
  fetched_at: string;
  weather: WeatherDoc;
  soil: SoilSummary;
  constraints: string[];
  summary: string;
}

export async function fetchEco(lat: number, lon: number): Promise<EcoReport> {
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

const isMain = import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`;
if (isMain) {
  const [ll, outFlag, outPath] = process.argv.slice(2);
  if (!ll?.includes(',')) {
    console.error('Usage: node dist/lib/eco.js <lat,lon> [--out samples/eco-x.json] [--root <projectDir>]');
    process.exit(2);
  }
  try {
    const [lat, lon] = ll.split(',').map(Number);
    const eco = await fetchEco(lat as number, lon as number);
    const text = JSON.stringify(eco, null, 2);
    if (outFlag === '--out' && outPath) {
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, text + '\n');
      console.error(`wrote ${outPath} (${eco.constraints.length} constraints)`);
    }
    const rootFlag = process.argv.includes('--root')
      ? (process.argv[process.argv.indexOf('--root') + 1] ?? null)
      : null;
    if (rootFlag && !rootFlag.startsWith('--')) {
      const { setDoc } = await import('./db.js');
      setDoc(rootFlag, 'eco', { summary: eco.summary, location: eco.location, fetched_at: eco.fetched_at });
      console.error(`stored eco doc in ${rootFlag}`);
    }
    console.log(text);
  } catch (err) {
    console.error(`eco failed: ${(err as Error).message}`);
    process.exit(1);
  }
}
