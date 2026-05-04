import express from 'express';
import cors from 'cors';
import https from 'https';

const app = express();

const PORT = process.env.PORT || 3000;

const DFTRANS_GPS_URL =
  process.env.DFTRANS_GPS_URL ||
  'https://www.sistemas.dftrans.df.gov.br/service/gps/operacoes';

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 30000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 25000);

let cache = {
  data: null,
  updatedAt: null,
  source: null,
  lastError: null,
  loading: false,
};

app.use(cors({
  origin: '*',
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '1mb' }));

function requestText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          Accept: 'application/json,text/plain,*/*',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
          Referer: 'https://www.sistemas.dftrans.df.gov.br/',
        },
        rejectUnauthorized: false,
      },
      (response) => {
        let raw = '';

        response.setEncoding('utf8');

        response.on('data', (chunk) => {
          raw += chunk;
        });

        response.on('end', () => {
          resolve({
            statusCode: response.statusCode,
            statusMessage: response.statusMessage,
            headers: response.headers,
            body: raw,
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('Timeout ao consultar DFTrans GPS'));
    });

    req.on('error', (error) => {
      reject(error);
    });
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
        id: `${vehicle.numero || 'sem-numero'}-${vehicle.linha || 'sem-linha'}`,
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

async function refreshCache() {
  if (cache.loading) return cache;

  cache.loading = true;

  try {
    const response = await requestText(DFTRANS_GPS_URL);

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`DFTrans retornou ${response.statusCode}: ${response.body?.slice(0, 200)}`);
    }

    const rawData = JSON.parse(response.body);
    const vehicles = flattenVehicles(rawData);

    cache = {
      data: {
        ok: true,
        updatedAt: new Date().toISOString(),
        updatedAtMs: Date.now(),
        source: 'DFTrans GPS',
        totalOperadoras: Array.isArray(rawData) ? rawData.length : 0,
        totalVeiculos: vehicles.length,
        totalComLinha: vehicles.filter((v) => v.linha).length,
        raw: rawData,
        vehicles,
      },
      updatedAt: Date.now(),
      source: 'DFTrans GPS',
      lastError: null,
      loading: false,
    };

    console.log(`[DFTrans GPS] Cache atualizado: ${vehicles.length} veículos`);

    return cache;
  } catch (error) {
    cache.loading = false;
    cache.lastError = {
      message: error?.message || String(error),
      at: new Date().toISOString(),
    };

    console.error('[DFTrans GPS] Erro ao atualizar cache:', cache.lastError);

    return cache;
  }
}

function isCacheFresh() {
  if (!cache.data || !cache.updatedAt) return false;
  return Date.now() - cache.updatedAt <= CACHE_TTL_MS;
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    name: 'DFTrans Railway API',
    routes: {
      health: '/health',
      gps: '/api/dftrans-gps',
      vehicles: '/api/vehicles',
      vehiclesByLine: '/api/vehicles?linha=143.2',
    },
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    status: 'online',
    cache: {
      hasData: Boolean(cache.data),
      updatedAt: cache.data?.updatedAt || null,
      totalVeiculos: cache.data?.totalVeiculos || 0,
      totalComLinha: cache.data?.totalComLinha || 0,
      lastError: cache.lastError,
    },
  });
});

app.get('/api/dftrans-gps', async (req, res) => {
  if (!isCacheFresh()) {
    await refreshCache();
  }

  if (cache.data) {
    return res.json({
      ...cache.data,
      cache: {
        fresh: isCacheFresh(),
        ageSeconds: Math.round((Date.now() - cache.updatedAt) / 1000),
      },
      warning: cache.lastError
        ? 'Usando último cache disponível porque a última atualização falhou.'
        : null,
    });
  }

  return res.status(502).json({
    ok: false,
    source: 'DFTrans GPS',
    error: 'Não foi possível consultar o DFTrans e ainda não existe cache.',
    detail: cache.lastError?.message || null,
  });
});

app.get('/api/vehicles', async (req, res) => {
  if (!isCacheFresh()) {
    await refreshCache();
  }

  if (!cache.data) {
    return res.status(502).json({
      ok: false,
      error: 'Sem dados de veículos no momento.',
      detail: cache.lastError?.message || null,
    });
  }

  const linhaQuery = String(req.query.linha || '').trim().toLowerCase();

  let vehicles = cache.data.vehicles || [];

  if (linhaQuery) {
    vehicles = vehicles.filter((vehicle) =>
      String(vehicle.linha || '').toLowerCase() === linhaQuery
    );
  }

  return res.json({
    ok: true,
    updatedAt: cache.data.updatedAt,
    updatedAtMs: cache.data.updatedAtMs,
    source: 'DFTrans GPS',
    linha: linhaQuery || null,
    total: vehicles.length,
    vehicles,
    cache: {
      fresh: isCacheFresh(),
      ageSeconds: Math.round((Date.now() - cache.updatedAt) / 1000),
    },
  });
});

app.get('/api/vehicles/nearby', async (req, res) => {
  if (!isCacheFresh()) {
    await refreshCache();
  }

  if (!cache.data) {
    return res.status(502).json({
      ok: false,
      error: 'Sem dados de veículos no momento.',
      detail: cache.lastError?.message || null,
    });
  }

  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radiusKm = Number(req.query.radiusKm || 2);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({
      ok: false,
      error: 'Informe lat e lon válidos.',
      example: '/api/vehicles/nearby?lat=-15.7934&lon=-47.8823&radiusKm=2',
    });
  }

  const vehicles = (cache.data.vehicles || [])
    .map((vehicle) => {
      const distanceKm = haversineKm(lat, lon, vehicle.lat, vehicle.lon);
      return {
        ...vehicle,
        distanceKm: Number(distanceKm.toFixed(3)),
      };
    })
    .filter((vehicle) => vehicle.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  return res.json({
    ok: true,
    updatedAt: cache.data.updatedAt,
    source: 'DFTrans GPS',
    total: vehicles.length,
    radiusKm,
    vehicles,
  });
});

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;

  const dLat = toRad(Number(lat2) - Number(lat1));
  const dLon = toRad(Number(lon2) - Number(lon1));

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(Number(lat1))) *
      Math.cos(toRad(Number(lat2))) *
      Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(value) {
  return value * Math.PI / 180;
}

// Atualiza ao iniciar, mas não trava o servidor se falhar
refreshCache();

setInterval(() => {
  refreshCache();
}, CACHE_TTL_MS);

app.listen(PORT, () => {
  console.log(`DFTrans Railway API rodando na porta ${PORT}`);
});