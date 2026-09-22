// scripts/geocodificar-campos.js
//
// Uso único (o cada vez que agregues un campo nuevo sin coordenadas).
// Para cada fila de tri_campos con lat/lon en null:
//   1) busca su localidad en el geocodificador gratuito de Open-Meteo
//   2) si encuentra una coincidencia en Argentina, guarda lat/lon
//
// Variables de entorno: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

async function geocodificar(localidad) {
  const url = `https://geocoding-api.open-meteo.com/v1/search` +
    `?name=${encodeURIComponent(localidad)}&count=5&language=es&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding respondió ${res.status}`);
  const json = await res.json();
  const candidatos = json.results || [];
  // preferimos un resultado en Argentina si hay varios con el mismo nombre
  const enArgentina = candidatos.find((c) => c.country_code === "AR");
  return enArgentina || candidatos[0] || null;
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el entorno.");
    process.exit(1);
  }

  const campos = await sbFetch("tri_campos?select=id,nombre,localidad,lat,lon&lat=is.null");
  if (campos.length === 0) {
    console.log("Todos los campos ya tienen coordenadas. Nada para hacer.");
    return;
  }

  let ok = 0;
  const sinResolver = [];

  for (const campo of campos) {
    const consulta = campo.localidad || campo.nombre;
    try {
      const match = await geocodificar(consulta);
      if (!match) throw new Error("sin resultados");
      await sbFetch(`tri_campos?id=eq.${campo.id}`, {
        method: "PATCH",
        body: JSON.stringify({ lat: match.latitude, lon: match.longitude }),
      });
      console.log(`OK  ${campo.nombre.padEnd(16)} (${consulta}) -> ${match.latitude}, ${match.longitude}`);
      ok++;
    } catch (e) {
      console.error(`SIN RESOLVER  ${campo.nombre} (${consulta}): ${e.message}`);
      sinResolver.push(campo.nombre);
    }
  }

  console.log(`\n${ok}/${campos.length} campos geocodificados.`);
  if (sinResolver.length > 0) {
    console.log("Revisar a mano:", sinResolver.join(", "));
    process.exitCode = 1;
  }
}

main();
