// scripts/auditoria-gdu.js
//
// SOLO LECTURA sobre Supabase. No modifica nada.
// Por cada proyecto con siembra de hembra, compara el GDU acumulado calculado con
// distintas fuentes de temperatura, en la MISMA ventana de días (siembra+1 hasta el último
// día en que todas las fuentes tienen dato).
//
// Fuentes:
//   nuestra      -> tri_clima_diario (lo que guarda hoy el workflow diario)
//   era5land     -> Open-Meteo archive, modelo ERA5-Land (reanálisis, ~9 km)
//   ecmwf        -> Open-Meteo historical-forecast, ECMWF IFS 0.25°
//   icon         -> Open-Meteo historical-forecast, ICON (DWD)
//   nasa         -> NASA POWER (MERRA-2, ~50 km, con 2-3 días de atraso)
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Salida: resumen del run + auditoria-gdu.csv

const fs = require("fs");
const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TZ = "America/Argentina/Buenos_Aires";

const gdu = (tmax, tmin) => Math.max(0, (Math.min(tmax, 30) + Math.max(tmin, 10)) / 2 - 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (x) => (x == null ? "—" : Number(x).toFixed(1));
const sum = (a) => a.reduce((s, x) => s + x, 0);

function resumen(t) {
  console.log(t);
  if (process.env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, t + "\n"); } catch (e) {} }
}

async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${txt.slice(0, 200)}`);
  return JSON.parse(txt);
}

async function getJson(url) {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url);
    const txt = await res.text();
    if (res.ok) return JSON.parse(txt);
    if (res.status === 429 && i < 2) { await sleep(15000); continue; }
    throw new Error(`${res.status}: ${txt.slice(0, 150)}`);
  }
}

// Cada fetcher devuelve { 'YYYY-MM-DD': {tmax, tmin} }
function desdeOpenMeteo(json, sufijo) {
  const out = {};
  const d = json.daily || {};
  (d.time || []).forEach((f, i) => {
    const tx = d["temperature_2m_max" + sufijo]?.[i], tn = d["temperature_2m_min" + sufijo]?.[i];
    if (tx != null && tn != null) out[f] = { tmax: tx, tmin: tn };
  });
  return out;
}
async function era5land(c, ini, fin) {
  const j = await getJson(`https://archive-api.open-meteo.com/v1/archive?latitude=${c.lat}&longitude=${c.lon}&start_date=${ini}&end_date=${fin}&daily=temperature_2m_max,temperature_2m_min&models=era5_land&timezone=${TZ}`);
  return desdeOpenMeteo(j, "");
}
async function histForecast(c, ini, fin, modelo) {
  const j = await getJson(`https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}&start_date=${ini}&end_date=${fin}&daily=temperature_2m_max,temperature_2m_min&models=${modelo}&timezone=${TZ}`);
  return desdeOpenMeteo(j, "");
}
async function nasa(c, ini, fin) {
  const q = (s) => s.replace(/-/g, "");
  const j = await getJson(`https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M_MAX,T2M_MIN&community=AG&longitude=${c.lon}&latitude=${c.lat}&start=${q(ini)}&end=${q(fin)}&format=JSON`);
  const mx = j.properties?.parameter?.T2M_MAX || {}, mn = j.properties?.parameter?.T2M_MIN || {};
  const out = {};
  for (const k of Object.keys(mx)) {
    if (mx[k] > -900 && mn[k] > -900) out[`${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`] = { tmax: mx[k], tmin: mn[k] };
  }
  return out;
}

const FUENTES = [
  ["era5land", era5land],
  ["ecmwf", (c, i, f) => histForecast(c, i, f, "ecmwf_ifs025")],
  ["icon", (c, i, f) => histForecast(c, i, f, "icon_seamless")],
  ["nasa", nasa],
];

function ayerART() {
  const d = new Date(Date.now() - 3 * 3600e3);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function sumaDias(f, n) { const d = new Date(f + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

async function main() {
  if (!SUPABASE_URL || !KEY) { resumen("Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
  resumen("## Auditoría GDU — comparación de fuentes de temperatura");

  const etapas = await sb("tri_etapas?select=id&nombre=eq.Siembra Hembra");
  const proys = await sb("tri_proyectos?select=id,proyecto,campo_id&order=proyecto&limit=1000");
  const campos = await sb("tri_campos?select=id,nombre,lat,lon&limit=1000");
  const evs = await sb(`tri_evidencias?select=proyecto_id,fecha&etapa_id=eq.${etapas[0].id}&limit=1000`);
  const siembra = {};
  for (const e of evs) if (!siembra[e.proyecto_id] || e.fecha < siembra[e.proyecto_id]) siembra[e.proyecto_id] = e.fecha;

  const fin = ayerART();
  const csv = ["proyecto,campo,fuente,fecha,tmax,tmin,gdu_dia"];
  const filasResumen = [];

  for (const campo of campos) {
    const ps = proys.filter((p) => p.campo_id === campo.id && siembra[p.id]);
    if (!ps.length || campo.lat == null) continue;
    const ini = ps.map((p) => siembra[p.id]).sort()[0];
    const series = {};
    const clima = await sb(`tri_clima_diario?select=fecha,tmax,tmin&campo_id=eq.${campo.id}&fecha=gte.${ini}&limit=1000`);
    series.nuestra = {};
    clima.forEach((k) => { if (k.tmax != null && k.tmin != null) series.nuestra[k.fecha] = { tmax: +k.tmax, tmin: +k.tmin }; });
    for (const [nombre, fn] of FUENTES) {
      try { series[nombre] = await fn(campo, ini, fin); }
      catch (e) { resumen(`- ${campo.nombre} / ${nombre}: **error** ${String(e.message).slice(0, 120)}`); series[nombre] = {}; }
      await sleep(1200);
    }
    for (const p of ps) {
      const desde = sumaDias(siembra[p.id], 1);
      const fuentesOk = Object.keys(series).filter((n) => Object.keys(series[n]).length > 0);
      // ventana común: días >= desde y <= fin donde TODAS las fuentes disponibles tienen dato
      const dias = [];
      for (let f = desde; f <= fin; f = sumaDias(f, 1)) if (fuentesOk.every((n) => series[n][f])) dias.push(f);
      const base = dias.map((f) => gdu(series.nuestra[f]?.tmax, series.nuestra[f]?.tmin));
      const gBase = sum(base);
      for (const n of fuentesOk) {
        const v = dias.map((f) => series[n][f]);
        const g = sum(v.map((x) => gdu(x.tmax, x.tmin)));
        const mx = v.length ? sum(v.map((x) => x.tmax)) / v.length : null;
        const mn = v.length ? sum(v.map((x) => x.tmin)) / v.length : null;
        filasResumen.push({ p: p.proyecto, campo: campo.nombre, n, dias: dias.length, mn, mx, g, dif: g - gBase });
        dias.forEach((f) => csv.push(`${p.proyecto},${campo.nombre},${n},${f},${series[n][f].tmax},${series[n][f].tmin},${gdu(series[n][f].tmax, series[n][f].tmin).toFixed(2)}`));
      }
    }
  }

  resumen("\nVentana = desde el día siguiente a la siembra hasta el último día con dato en todas las fuentes. Diferencia = GDU de la fuente − GDU de nuestra serie.\n");
  resumen("| Proyecto | Campo | Fuente | Días | Tmin prom | Tmax prom | GDU acum | Dif vs nuestra |\n|---|---|---|---|---|---|---|---|");
  for (const f of filasResumen) {
    resumen(`| ${f.p} | ${f.campo} | ${f.n} | ${f.dias} | ${r1(f.mn)} | ${r1(f.mx)} | ${r1(f.g)} | ${f.n === "nuestra" ? "—" : (f.dif >= 0 ? "+" : "") + r1(f.dif)} |`);
  }
  fs.writeFileSync("auditoria-gdu.csv", csv.join("\n"));
  resumen(`\nCSV con el detalle diario: artifact **auditoria-gdu** del run.`);
}
main().catch((e) => { resumen("**Error:** " + String(e.stack || e)); process.exitCode = 1; });
