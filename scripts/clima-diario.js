// scripts/clima-diario.js
//
// Corre desde GitHub Actions, una vez por día. Por cada campo con lat/lon
// cargados en tri_campos:
//   1) pide a Open-Meteo la Tmax/Tmin de AYER
//   2) calcula GDU día = ((min(Tmax,30) + max(Tmin,10)) / 2) - 10, piso en 0
//   3) guarda (o actualiza) la fila en tri_clima_diario
//
// Variables de entorno (las pone el workflow, ver clima-diario.yml):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const fs = require("fs");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY;

const GDU_TECHO_MAX = 30;
const GDU_PISO_MIN = 10;
const GDU_BASE = 10;

function escribirResumen(texto){
  console.log(texto.replace(/\|/g, " ").replace(/\n+/g, "\n"));
  if (SUMMARY_FILE) {
    try { fs.appendFileSync(SUMMARY_FILE, texto + "\n"); } catch (e) { /* no bloquea el run */ }
  }
}

function calcularGduDia(tmax, tmin) {
  const tmaxCap = Math.min(tmax, GDU_TECHO_MAX);
  const tminCap = Math.max(tmin, GDU_PISO_MIN);
  const gdu = (tmaxCap + tminCap) / 2 - GDU_BASE;
  return Math.max(0, Number(gdu.toFixed(2)));
}

function fechaAyerISO() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function sbFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase ${res.status}: ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

async function main() {
  escribirResumen(`## Clima diario — resultado del run`);

  if (!SUPABASE_URL || !SERVICE_KEY) {
    escribirResumen(`**Faltan variables de entorno** — SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no llegaron al script. Revisá los secrets del repo.`);
    process.exit(1);
  }

  const campos = await sbFetch("tri_campos?select=id,nombre,lat,lon&lat=not.is.null&lon=not.is.null");
  const fecha = fechaAyerISO();

  escribirResumen(`Fecha calculada (ayer, UTC): **${fecha}**  \nCampos con coordenadas encontrados: **${campos.length}**`);

  if (campos.length === 0) {
    escribirResumen(`\nNo hay ningún campo con lat/lon cargados — no hay nada para procesar. Revisá la tabla tri_campos.`);
    return;
  }

  let ok = 0;
  const filas = [`| Campo | Tmax | Tmin | GDU día | Estado |`, `|---|---|---|---|---|`];
  const errores = [];

  for (const campo of campos) {
    try {
      const url = `https://api.open-meteo.com/v1/forecast` +
        `?latitude=${campo.lat}&longitude=${campo.lon}` +
        `&daily=temperature_2m_max,temperature_2m_min` +
        `&timezone=auto&past_days=2&forecast_days=1`;

      const res = await fetch(url);
      if (!res.ok) throw new Error(`Open-Meteo respondió ${res.status}`);
      const json = await res.json();

      const idx = (json.daily?.time ?? []).indexOf(fecha);
      if (idx === -1) throw new Error(`Sin dato de Open-Meteo para ${fecha}`);

      const tmax = json.daily.temperature_2m_max[idx];
      const tmin = json.daily.temperature_2m_min[idx];
      const gduDia = calcularGduDia(tmax, tmin);

      await sbFetch("tri_clima_diario?on_conflict=campo_id,fecha", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ campo_id: campo.id, fecha, tmax, tmin, gdu_dia: gduDia }),
      });

      filas.push(`| ${campo.nombre} | ${tmax} | ${tmin} | ${gduDia} | OK |`);
      ok++;
    } catch (e) {
      filas.push(`| ${campo.nombre} | — | — | — | ERROR: ${String(e.message).slice(0, 80)} |`);
      errores.push({ campo: campo.nombre, error: e.message });
    }
  }

  escribirResumen(`\n${filas.join("\n")}`);
  escribirResumen(`\n**${ok}/${campos.length} campos actualizados** para ${fecha}.`);
  if (errores.length > 0) {
    escribirResumen(`Fallaron: ${errores.map((e) => e.campo).join(", ")}`);
    process.exitCode = 1; // marca el run como "failed" en Actions si algo falló
  }
}

main().catch((e) => {
  escribirResumen(`\n**Error inesperado, el script se cortó:** ${String(e && e.stack || e)}`);
  process.exitCode = 1;
});
