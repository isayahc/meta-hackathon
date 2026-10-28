// Ecology fusion tests. Offline: parse the Kansas fixture, pin rule
// thresholds, and check prompt wiring. No network, no API key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  normalizeSoil,
  ecoConstraints,
  summarizeEco,
  wmoText,
  RAIN_PROB_PCT,
  HEAT_C,
  FROST_C,
  WIND_KMH,
} from './eco.mjs';
import { buildOptimizerPrompt } from './analyze-response.mjs';

async function kansas(t = null) {
  const raw = await readFile(new URL('./samples/eco-kansas.json', import.meta.url), 'utf8');
  return JSON.parse(raw);
}

test('kansas fixture normalizes to physical units', async () => {
  const { soilDoc } = await kansas();
  const soil = normalizeSoil(soilDoc);
  assert.equal(soil.sand_pct, 68);
  assert.equal(soil.clay_pct, 18);
  assert.equal(soil.soc_gkg, 1.5);
  assert.equal(soil.ph, 6.8);
});

test('kansas fixture fires rain, wind, heat, and sandy-soil rules', async () => {
  const { weather, soilDoc } = await kansas();
  const c = ecoConstraints(weather, normalizeSoil(soilDoc));
  assert.equal(c.length, 4);
  assert.match(c.join('\n'), /Rain likely 2026-10-29 \(75%\)/);
  assert.match(c.join('\n'), /High wind 45\.5 km\/h/);
  assert.match(c.join('\n'), /Heat 36\.2°C 2026-10-30/);
  assert.match(c.join('\n'), /Sandy topsoil \(~68% sand\)/);
});

test('rules stay silent on benign weather and loam', () => {
  const weather = {
    daily: {
      time: ['2026-10-28'],
      temperature_2m_max: [24], temperature_2m_min: [12],
      precipitation_probability_max: [RAIN_PROB_PCT - 1],
      precipitation_sum: [0], wind_speed_10m_max: [WIND_KMH - 1],
    },
  };
  const soil = { sand_pct: 40, clay_pct: 20, soc_gkg: 18, ph: 6.5 };
  assert.deepEqual(ecoConstraints(weather, soil), []);
});

test('frost, clay, and pH rules fire at the boundary', () => {
  const weather = {
    daily: {
      time: ['2026-10-28'],
      temperature_2m_max: [HEAT_C - 1], temperature_2m_min: [FROST_C],
      precipitation_probability_max: [0], precipitation_sum: [0], wind_speed_10m_max: [10],
    },
  };
  const c = ecoConstraints(weather, { sand_pct: 30, clay_pct: 45, soc_gkg: 20, ph: 5.2 });
  assert.match(c.join('\n'), /Frost risk/);
  assert.match(c.join('\n'), /Heavy clay \(~45% clay\)/);
  assert.match(c.join('\n'), /pH 5\.2 outside/);
});

test('summary block names current, outlook, and soil', async () => {
  const { weather, soilDoc } = await kansas();
  const s = summarizeEco(weather, normalizeSoil(soilDoc), 38.5, -98.0);
  assert.match(s, /partly cloudy/);
  assert.match(s, /2026-10-29: .*rain 75%/);
  assert.match(s, /sand ~68%/);
  assert.match(s, /pH 6\.8/);
  assert.equal(wmoText(95), 'thunderstorm');
});

test('optimizer prompt carries the eco block and its constraints', async () => {
  const { weather, soilDoc } = await kansas();
  const soil = normalizeSoil(soilDoc);
  const constraints = ecoConstraints(weather, soil);
  const p = buildOptimizerPrompt(
    [{ id: 'h-1', text: 'Harvest bed 1', deadline: null, weight: 4, status: 'open' }],
    [],
    constraints,
    summarizeEco(weather, soil, 38.5, -98.0)
  );
  assert.match(p, /Field conditions \(ecology data\)/);
  assert.match(p, /Rain likely 2026-10-29/);
  assert.match(p, /sand ~68%/);
});

test('optimizer prompt without eco data is unchanged in shape', () => {
  const p = buildOptimizerPrompt([], [], []);
  assert.doesNotMatch(p, /Field conditions/);
  assert.match(p, /ranked_actions/);
});
