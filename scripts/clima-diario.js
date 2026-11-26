// scripts/clima-diario.js
//
// Corre desde GitHub Actions, una vez por día. Por cada campo con lat/lon
// cargados en tri_campos:
//   1) pide a Open-Meteo la Tmax/Tmin de AYER
//   2) calcula GDU día = ((min(Tmax,30) + max(Tmin,10)) / 2) - 10, piso en 0
//   3) guarda (o actualiza) la fila en tri_clima_diario
//   4) recalcula gdu_acumulado en tri_gdu_acumulado para todos los proyectos
//      activos (sumando tri_clima_diario desde la fecha de siembra de hembra)
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
  // "Ayer" según el calendario de Argentina (UTC-3, sin horario de verano),
  // no según UTC — de noche en Argentina, UTC ya está en el día siguiente,
  // y con la cuenta vieja eso hacía que el script guardara el día de HOY
  // (todavía sin terminar) como si fuera un dato ya cerrado.
  const OFFSET_ART_MS = 3 * 60 * 60 * 1000;
  const ahoraComoART = new Date(Date.now() - OFFSET_ART_MS);
  ahoraComoART.setUTCDate(ahoraComoART.getUTCDate() - 1);
  return ahoraComoART.toISOString().slice(0, 10);
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
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase ${res.status}: ${text}`);
  }
  if (!text) return null; // 201/204 sin body — respuesta normal en un INSERT/UPDATE
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Supabase respondió algo no-JSON (status ${res.status}): "${text.slice(0, 150)}"`);
  }
}

async function esperar(ms){
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      const bodyText = await res.text();
      if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${bodyText.slice(0, 150)}`);

      let json;
      try {
        json = JSON.parse(bodyText);
      } catch (e) {
        throw new Error(`Respuesta no-JSON de Open-Meteo (status ${res.status}): "${bodyText.slice(0, 150)}"`);
      }

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
      filas.push(`| ${campo.nombre} | — | — | — | ERROR: ${String(e.message).slice(0, 150)} |`);
      errores.push({ campo: campo.nombre, error: e.message });
    }
    await esperar(400); // pausa chica entre pedidos, para no saturar Open-Meteo
  }

  escribirResumen(`\n${filas.join("\n")}`);
  escribirResumen(`\n**${ok}/${campos.length} campos actualizados** para ${fecha}.`);
  if (errores.length > 0) {
    escribirResumen(`Fallaron: ${errores.map((e) => e.campo).join(", ")}`);
    process.exitCode = 1; // marca el run como "failed" en Actions si algo falló
  }

  // ── Paso 4: recalcular gdu_acumulado en tri_gdu_acumulado ──────────────────
  // Por cada fila de tri_gdu_acumulado que tenga fecha_siembra_hembra,
  // suma los GDU diarios de tri_clima_diario del campo correspondiente
  // desde esa fecha (inclusive) hasta hoy, y actualiza el campo.
  // Es idempotente: se puede correr N veces sin problema.
  escribirResumen(`\n## Recálculo de GDU acumulado`);
  try {
    // Traer todos los proyectos activos con siembra de hembra registrada
    const proyectos = await sbFetch(
      "tri_gdu_acumulado?select=proyecto_id,proyecto,fecha_siembra_hembra" +
      "&fecha_siembra_hembra=not.is.null"
    );

    if (!proyectos || proyectos.length === 0) {
      escribirResumen(`Sin proyectos con siembra de hembra en tri_gdu_acumulado — nada que recalcular.`);
    } else {
      // Traer campo_id de cada proyecto
      const proyIds = proyectos.map((p) => `id=eq.${p.proyecto_id}`).join("&or=");
      const proyData = await sbFetch(
        `tri_proyectos?select=id,campo_id&or=(${proyIds})`
      );
      const campoMap = {}; // proyecto_id -> campo_id
      for (const p of proyData) campoMap[p.id] = p.campo_id;

      const filasGdu = [`| Proyecto | Fecha siembra | GDU acumulado |`, `|---|---|---|`];
      let okGdu = 0;

      for (const p of proyectos) {
        const campoId = campoMap[p.proyecto_id];
        if (!campoId) {
          filasGdu.push(`| ${p.proyecto} | ${p.fecha_siembra_hembra} | sin campo_id |`);
          continue;
        }

        // Sumar GDU diarios desde la fecha de siembra (inclusive)
        // La fórmula GDU empieza a contar desde el día siguiente a la siembra,
        // pero para ser conservadores sumamos desde la siembra inclusive.
        const climaProyecto = await sbFetch(
          `tri_clima_diario?select=gdu_dia` +
          `&campo_id=eq.${campoId}` +
          `&fecha=gte.${p.fecha_siembra_hembra}` +
          `&gdu_dia=not.is.null`
        );

        const totalGdu = (climaProyecto || []).reduce(
          (sum, row) => sum + Number(row.gdu_dia),
          0
        );
        const totalRedondeado = Number(totalGdu.toFixed(1));

        // Actualizar tri_gdu_acumulado
        await sbFetch(
          `tri_gdu_acumulado?proyecto_id=eq.${p.proyecto_id}`,
          {
            method: "PATCH",
            body: JSON.stringify({ gdu_acumulado: totalRedondeado }),
          }
        );

        filasGdu.push(`| ${p.proyecto} | ${p.fecha_siembra_hembra} | ${totalRedondeado} GDU |`);
        okGdu++;
        await esperar(100);
      }

      escribirResumen(filasGdu.join("\n"));
      escribirResumen(`\n**${okGdu}/${proyectos.length} proyectos actualizados.**`);
    }
  } catch (e) {
    escribirResumen(`**Error en recálculo GDU acumulado:** ${String(e.message).slice(0, 300)}`);
    // No seteamos exitCode aquí para no ocultar errores del paso de clima
  }
}

main().catch((e) => {
  escribirResumen(`\n**Error inesperado, el script se cortó:** ${String(e && e.stack || e)}`);
  process.exitCode = 1;
});
