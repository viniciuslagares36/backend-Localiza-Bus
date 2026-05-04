const DFTRANS_GPS_URL =
  'https://www.sistemas.dftrans.df.gov.br/service/gps/operacoes';

const CACHE_TTL_SECONDS = 25;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  });
}

function flattenVehicles(rawData) {
  if (!Array.isArray(rawData)) return [];

  const vehicles = [];

  for (const group of rawData) {
    const operadora = group?.operadora || {};
    const veiculos = Array.isArray(group?.veiculos) ? group.veiculos : [];

    for (const vehicle of veiculos) {
      const lat = vehicle?.localizacao?.latitude;
      const lon = vehicle?.localizacao?.longitude;

      if (!lat || !lon) continue;

      vehicles.push({
        id: `${vehicle.numero || 'sem-numero'}-${vehicle.linha || 'sem-linha'}-${vehicle.horario || ''}`,
        numero: vehicle.numero || '',
        linha: vehicle.linha || '',
        horario: vehicle.horario || null,
        lat,
        lon,
        speed: vehicle?.velocidade?.valor ?? 0,
        velocidade: vehicle?.velocidade || null,
        direcao: vehicle.direcao ?? null,
        sentido: vehicle.sentido ?? null,
        valid: Boolean(vehicle.valid),
        codigoImei: vehicle.codigoImei || '',
        operadora: {
          id: operadora.id || null,
          nome: operadora.nome || '',
          sigla: operadora.sigla || '',
          razaoSocial: operadora.razaoSocial || '',
        },
      });
    }
  }

  return vehicles;
}

async function getDftransGps() {
  const cache = caches.default;
  const cacheKey = new Request('https://localizabus-cache/dftrans-gps');

  const cached = await cache.match(cacheKey);

  if (cached) {
    const cachedData = await cached.json();

    return jsonResponse(
      {
        ...cachedData,
        cache: {
          hit: true,
          ttlSeconds: CACHE_TTL_SECONDS,
        },
      },
      200,
      {
        'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
      }
    );
  }

  const response = await fetch(DFTRANS_GPS_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/json,text/plain,*/*',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      Referer: 'https://www.sistemas.dftrans.df.gov.br/',
      'Cache-Control': 'no-cache',
    },
    cf: {
      cacheTtl: CACHE_TTL_SECONDS,
      cacheEverything: false,
    },
  });

  const text = await response.text();

  if (!response.ok) {
    return jsonResponse(
      {
        ok: false,
        source: 'DFTrans GPS',
        error: `DFTrans retornou ${response.status}`,
        status: response.status,
        preview: text.slice(0, 500),
      },
      response.status || 502
    );
  }

  let rawData;

  try {
    rawData = JSON.parse(text);
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        source: 'DFTrans GPS',
        error: 'DFTrans respondeu, mas não retornou JSON válido.',
        preview: text.slice(0, 500),
      },
      502
    );
  }

  const vehicles = flattenVehicles(rawData);

  const payload = {
    ok: true,
    source: 'DFTrans GPS via Cloudflare Worker',
    updatedAt: new Date().toISOString(),
    updatedAtMs: Date.now(),
    totalOperadoras: Array.isArray(rawData) ? rawData.length : 0,
    totalVeiculos: vehicles.length,
    totalComLinha: vehicles.filter((v) => v.linha).length,
    raw: rawData,
    vehicles,
    cache: {
      hit: false,
      ttlSeconds: CACHE_TTL_SECONDS,
    },
  };

  const responseToCache = jsonResponse(payload, 200, {
    'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
  });

  await cache.put(cacheKey, responseToCache.clone());

  return responseToCache;
}

async function getVehiclesByLine(url) {
  const gpsResponse = await getDftransGps();
  const data = await gpsResponse.clone().json();

  if (!data.ok) return gpsResponse;

  const linha = String(url.searchParams.get('linha') || '')
    .trim()
    .toLowerCase();

  let vehicles = data.vehicles || [];

  if (linha) {
    vehicles = vehicles.filter(
      (vehicle) => String(vehicle.linha || '').toLowerCase() === linha
    );
  }

  return jsonResponse({
    ok: true,
    source: data.source,
    updatedAt: data.updatedAt,
    updatedAtMs: data.updatedAtMs,
    linha: linha || null,
    total: vehicles.length,
    vehicles,
    cache: data.cache,
  });
}

function health() {
  return jsonResponse({
    ok: true,
    name: 'DFTrans GPS Proxy - Cloudflare Worker',
    routes: {
      health: '/health',
      gps: '/api/dftrans-gps',
      vehicles: '/api/vehicles',
      vehiclesByLine: '/api/vehicles?linha=143.2',
    },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    if (request.method !== 'GET') {
      return jsonResponse(
        {
          ok: false,
          error: 'Método não permitido. Use GET.',
        },
        405
      );
    }

    try {
      if (url.pathname === '/' || url.pathname === '/health') {
        return health();
      }

      if (url.pathname === '/api/dftrans-gps') {
        return await getDftransGps();
      }

      if (url.pathname === '/api/vehicles') {
        return await getVehiclesByLine(url);
      }

      return jsonResponse(
        {
          ok: false,
          error: 'Rota não encontrada.',
          availableRoutes: ['/health', '/api/dftrans-gps', '/api/vehicles'],
        },
        404
      );
    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          source: 'Cloudflare Worker',
          error: 'Falha ao consultar DFTrans GPS.',
          detail: error?.message || String(error),
        },
        502
      );
    }
  },
};