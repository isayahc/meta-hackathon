// Top-down SVG renderer for floorplan-web-10 SpaceIR scenes, plus a gallery page.
// Usage: node render.mjs
// Convention (documented, not observed): SVG x = world +X, SVG y = world -Z (north up).
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(join(HERE, 'manifest.json'), 'utf8'));
const summary = JSON.parse(await readFile(join(HERE, 'summary.json'), 'utf8'));

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r2 = (n) => Math.round(n * 100) / 100;

const REGION_STYLE = {
  room: ['#dbeafe', '#3b82f6'],
  outdoor: ['#dcfce7', '#16a34a'],
  zone: ['#fef3c7', '#d97706'],
};

// Arc-length interpolation of the [s0,s1] fraction window along a polyline.
function spanSegment(path, s0, s1) {
  const pts = path.map(([x, z]) => [x, z]);
  const segLen = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const L = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    segLen.push(L);
    total += L;
  }
  if (!(total > 0)) return null;
  const at = (d) => {
    let acc = 0;
    for (let i = 0; i < segLen.length; i++) {
      if (d <= acc + segLen[i] || i === segLen.length - 1) {
        const t = segLen[i] > 0 ? (d - acc) / segLen[i] : 0;
        const a = pts[i];
        const b = pts[i + 1];
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      }
      acc += segLen[i];
    }
    return pts[pts.length - 1];
  };
  const [a, b] = [Math.min(s0, s1), Math.max(s0, s1)];
  const out = [at(a * total)];
  let acc = 0;
  for (let i = 0; i < segLen.length; i++) {
    acc += segLen[i];
    const f = acc / total;
    if (f > a && f < b) out.push(pts[i + 1]);
  }
  out.push(at(b * total));
  return out;
}

function centroid(poly) {
  let x = 0;
  let z = 0;
  for (const [px, pz] of poly) { x += px; z += pz; }
  return [x / poly.length, z / poly.length];
}

function niceBar(extent) {
  for (const c of [50, 20, 10, 5, 2, 1, 0.5]) if (c <= extent / 3) return c;
  return 0.5;
}

function renderScene(id, ir) {
  const regions = (ir.regions ?? []).filter((r) => Array.isArray(r.polygon) && r.polygon.length >= 3);
  const regionless = (ir.regions ?? []).filter((r) => !(Array.isArray(r.polygon) && r.polygon.length >= 3));
  const walls = (ir.boundaries ?? []).filter((b) => Array.isArray(b.path) && b.path.length >= 2);
  const wallless = (ir.boundaries ?? []).filter((b) => !(Array.isArray(b.path) && b.path.length >= 2));
  const occs = (ir.occupancies ?? []).filter((o) => Array.isArray(o.polygon) && o.polygon.length >= 3);
  const occless = (ir.occupancies ?? []).filter((o) => !(Array.isArray(o.polygon) && o.polygon.length >= 3));
  const byId = new Map((ir.boundaries ?? []).map((b) => [b.id, b]));
  const portalSegs = [];
  let portalsSkipped = 0;
  for (const p of (ir.portals ?? [])) {
    const b = byId.get(p.boundary_id);
    const span = Array.isArray(p.span) && p.span.length === 2 ? p.span : null;
    const seg = b && Array.isArray(b.path) && b.path.length >= 2 && span ? spanSegment(b.path, span[0], span[1]) : null;
    if (seg) portalSegs.push({ portal: p, seg });
    else portalsSkipped += 1;
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const eat = ([x, z]) => {
    if (Number.isFinite(x) && Number.isFinite(z)) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
  };
  const site = ir.site;
  if (site) { eat([-site.width_m / 2, -site.depth_m / 2]); eat([site.width_m / 2, site.depth_m / 2]); }
  for (const r of regions) r.polygon.forEach(eat);
  for (const b of walls) b.path.forEach(eat);
  for (const o of occs) o.polygon.forEach(eat);
  if (!Number.isFinite(minX)) { minX = -1; maxX = 1; minZ = -1; maxZ = 1; }
  const padX = Math.max((maxX - minX) * 0.08, 0.5);
  const padZ = Math.max((maxZ - minZ) * 0.08, 0.5);
  minX -= padX; maxX += padX; minZ -= padZ; maxZ += padZ;

  const W = 760;
  const scale = W / (maxX - minX);
  const H = Math.round((maxZ - minZ) * scale);
  const HEAD = 66;
  const FOOT = 30;
  const X = (x) => r2((x - minX) * scale);
  const Y = (z) => r2(HEAD + (maxZ - z) * scale);
  const pts = (poly) => poly.map(([x, z]) => `${X(x)},${Y(z)}`).join(' ');

  const parts = [];
  parts.push(`<rect x="0" y="0" width="${W}" height="${HEAD + H + FOOT}" fill="#ffffff"/>`);
  const siteTxt = site ? `${r2(site.width_m)}x${r2(site.depth_m)}x${r2(site.height_m)} m` : 'unscaled';
  parts.push(`<text x="12" y="24" font-family="sans-serif" font-size="16" font-weight="bold" fill="#111827">${esc(id)}</text>`);
  parts.push(`<text x="12" y="44" font-family="sans-serif" font-size="11" fill="#4b5563">site ${esc(siteTxt)} · ${regions.length} regions · ${walls.length} walls · ${portalSegs.length} portals · ${occs.length} equipment · top-down, x=+X east, y=\u2212Z north</text>`);
  // North arrow.
  parts.push(`<g transform="translate(${W - 44},${HEAD + 34})"><circle r="16" fill="#f3f4f6" stroke="#9ca3af"/><path d="M0,10 L0,-10 M-6,-3 L0,-10 L6,-3" stroke="#111827" stroke-width="2" fill="none"/><text y="-20" text-anchor="middle" font-family="sans-serif" font-size="11" font-weight="bold" fill="#111827">N</text></g>`);
  // Site rect.
  if (site) {
    parts.push(`<rect x="${X(-site.width_m / 2)}" y="${Y(site.depth_m / 2)}" width="${r2(site.width_m * scale)}" height="${r2(site.depth_m * scale)}" fill="none" stroke="#9ca3af" stroke-dasharray="6,4"><title>site ${esc(siteTxt)}</title></rect>`);
  }
  // Regions.
  for (const r of regions) {
    const [fill, stroke] = REGION_STYLE[r.kind] ?? ['#f1f5f9', '#64748b'];
    const [cx, cz] = centroid(r.polygon);
    parts.push(`<polygon points="${pts(r.polygon)}" fill="${fill}" stroke="${stroke}" stroke-width="1"><title>${esc(r.id)} (${esc(r.kind)})</title></polygon>`);
    parts.push(`<text x="${X(cx)}" y="${Y(cz)}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#1f2937">${esc(r.label || r.id)}</text>`);
  }
  // Equipment.
  for (const o of occs) {
    parts.push(`<polygon points="${pts(o.polygon)}" fill="#fb923c" fill-opacity="0.55" stroke="#c2410c" stroke-dasharray="4,2"><title>${esc(o.id)}</title></polygon>`);
  }
  // Walls.
  const wallW = Math.max(1.5, r2(scale * 0.06));
  for (const b of walls) {
    parts.push(`<polyline data-layer="boundary" points="${pts(b.path)}" fill="none" stroke="#1f2937" stroke-width="${wallW}" stroke-linecap="round"><title>${esc(b.id)} (${esc(b.kind)})</title></polyline>`);
  }
  // Portals as spans over their parent wall.
  for (const { portal: p, seg } of portalSegs) {
    parts.push(`<polyline data-layer="portal" points="${pts(seg)}" fill="none" stroke="#22c55e" stroke-width="${wallW + 2.5}" stroke-linecap="round"><title>${esc(p.id)} (${esc(p.kind)}) on ${esc(p.boundary_id)}</title></polyline>`);
  }
  // Scale bar.
  const barM = niceBar(Math.max(maxX - minX, maxZ - minZ));
  const barW = r2(barM * scale);
  const bx = W - barW - 14;
  const by = HEAD + H - 12;
  parts.push(`<g><rect x="${bx}" y="${by - 5}" width="${barW}" height="5" fill="#111827"/><text x="${bx + barW / 2}" y="${by - 9}" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#111827">${barM} m</text></g>`);
  // Footer: unplaced entities.
  const missing = [...regionless.map((r) => r.id), ...wallless.map((b) => b.id), ...occless.map((o) => o.id)];
  const unresolved = Array.isArray(ir.unresolved) ? ir.unresolved.length : 0;
  let foot = `${unresolved} unresolved notes`;
  if (missing.length) foot += ` · ${missing.length} without geometry (not drawn): ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''}`;
  if (portalsSkipped) foot += ` · ${portalsSkipped} portals skipped (no parent path)`;
  parts.push(`<text x="12" y="${HEAD + H + 20}" font-family="sans-serif" font-size="10" fill="#6b7280">${esc(foot)}</text>`);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${HEAD + H + FOOT}" viewBox="0 0 ${W} ${HEAD + H + FOOT}">\n${parts.join('\n')}\n</svg>\n`;
  return {
    svg,
    counts: {
      regions: regions.length, regionless: regionless.length,
      walls: walls.length, wallless: wallless.length,
      portals: portalSegs.length, portalsSkipped,
      occupancies: occs.length, occless: occless.length,
      width: W, height: HEAD + H + FOOT,
    },
  };
}

const imageById = new Map(manifest.entries.map((e) => [e.id, e.file]));
const cards = [];
for (const r of summary.results) {
  const irPath = join(HERE, 'runs', r.id, 'oi-evidence', r.scene_id, 'space-ir.json');
  const ir = JSON.parse(await readFile(irPath, 'utf8'));
  const { svg, counts } = renderScene(r.id, ir);
  await writeFile(join(HERE, 'runs', r.id, 'render.svg'), svg);
  const u = r.understanding ?? {};
  cards.push({ id: r.id, scene: r.scene_id, counts, u, findings: r.findings ?? 0, diags: r.diagnostics ?? 0, attempts: r.attempts, image: imageById.get(r.id) });
  console.log(`[${r.id}] render.svg (${counts.width}x${counts.height}) regions=${counts.regions} walls=${counts.walls} portals=${counts.portals} equip=${counts.occupancies} missing=${counts.regionless + counts.wallless + counts.occless}`);
}

const cardHtml = cards.map((c) => `
<section style="border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin:12px 0;">
<h2 style="font-family:sans-serif;margin:0 0 4px;">${esc(c.id)}</h2>
<p style="font-family:sans-serif;color:#4b5563;margin:0 0 8px;">scene <code>${esc(c.scene.slice(0, 8))}</code> · rooms ${c.u.rooms} · walls ${c.u.walls} · openings ${c.u.openings} · equip ${c.u.equipment} · findings ${c.findings} · diagnostics ${c.diags} · tries ${c.attempts}</p>
<div style="display:flex;gap:12px;flex-wrap:wrap;">
<figure style="margin:0;flex:1;min-width:280px;"><figcaption style="font-family:sans-serif;">input</figcaption><img src="${esc(c.image)}" style="width:100%;border:1px solid #eee;"/></figure>
<figure style="margin:0;flex:1;min-width:280px;"><figcaption style="font-family:sans-serif;">rendered SpaceIR (<a href="runs/${esc(c.id)}/render.svg">svg</a>)</figcaption><img src="runs/${esc(c.id)}/render.svg" style="width:100%;border:1px solid #eee;"/></figure>
</div>
</section>`).join('\n');

await writeFile(join(HERE, 'index.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>floorplan-web-10 renders</title></head>
<body style="max-width:1100px;margin:auto;padding:16px;">
<h1 style="font-family:sans-serif;">floorplan-web-10 renders</h1>
<p style="font-family:sans-serif;color:#4b5563;">Top-down SpaceIR per scene. Convention: x = world +X (east right), y = world \u2212Z (north up). Green spans are portals (doors) over their parent wall; orange dashed footprints are equipment; dashed grey rect is the site. Generated ${esc(summary.generated_at)} · scale: fixed test assumption 18x14 m / 2.7 m unless the model observed a site.</p>
${cardHtml}
</body></html>
`);
console.log('index.html written.');
