const DFTRANS_GPS_URL =
  'https://www.sistemas.dftrans.df.gov.br/service/gps/operacoes';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
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


// Normaliza a linha digitada/retornada pela API para a busca não depender de formato exato.
// Exemplo real: o usuário pode digitar "0401", "401", "0.401" ou "401.1".
// Antes o backend comparava tudo no seco e só funcionava se viesse exatamente igual.
function normalizeLineText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/-/g, '')
    .replace(/_/g, '')
    .replace(/,/g, '.');
}

// Versão só com números. Ajuda quando a API vem com ponto e o usuário digita sem ponto.
// Exemplo: "0.401" vira "0401" e "401.1" vira "4011".
function onlyDigits(value) {
  return normalizeLineText(value).replace(/\D/g, '');
}

// Remove zeros à esquerda só para comparação numérica.
// Exemplo: "0401" e "401" passam a ser tratados como a mesma linha.
function stripLeadingZeros(value) {
  return String(value || '').replace(/^0+(?=\d)/, '');
}

// Cria variações de comparação para uma linha.
// Mantive separado e comentado para você conseguir mexer fácil depois.
function getLineVariants(value) {
  const clean = normalizeLineText(value);
  const digits = onlyDigits(value);
  const noLeadingZeroDigits = stripLeadingZeros(digits);
  const noDot = clean.replace(/\./g, '');
  const noLeadingZeroClean = clean.replace(/^0+(?=\d)/, '');

  return new Set(
    [clean, digits, noLeadingZeroDigits, noDot, noLeadingZeroClean]
      .filter(Boolean)
  );
}

// Decide se a linha do ônibus combina com o que o usuário pesquisou.
// A regra principal é igualdade entre variações normalizadas.
// A regra de "começa com" só entra quando a busca tem pelo menos 3 números,
// para evitar que pesquisar "1" traga ônibus demais sem querer.
function matchesLine(vehicleLine, searchedLine) {
  const vehicleVariants = getLineVariants(vehicleLine);
  const searchVariants = getLineVariants(searchedLine);

  for (const searchVariant of searchVariants) {
    if (vehicleVariants.has(searchVariant)) return true;
  }

  const searchedDigits = stripLeadingZeros(onlyDigits(searchedLine));

  if (searchedDigits.length >= 3) {
    for (const vehicleVariant of vehicleVariants) {
      const vehicleDigits = stripLeadingZeros(onlyDigits(vehicleVariant));

      if (
        vehicleDigits === searchedDigits ||
        vehicleDigits.startsWith(searchedDigits) ||
        searchedDigits.startsWith(vehicleDigits)
      ) {
        return true;
      }
    }
  }

  return false;
}

async function getDftransGps() {
  const response = await fetch(DFTRANS_GPS_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/json,text/plain,*/*',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      Referer: 'https://www.sistemas.dftrans.df.gov.br/',
      'Cache-Control': 'no-cache',
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

  return jsonResponse(
    {
      ok: true,
      source: 'DFTrans GPS via Cloudflare Pages Function',
      updatedAt: new Date().toISOString(),
      updatedAtMs: Date.now(),
      totalOperadoras: Array.isArray(rawData) ? rawData.length : 0,
      totalVeiculos: vehicles.length,
      totalComLinha: vehicles.filter((v) => v.linha).length,
      raw: rawData,
      vehicles,
    },
    200,
    {
      'Cache-Control': 'public, max-age=20',
    }
  );
}

async function getVehiclesByLine(url) {
  const gpsResponse = await getDftransGps();
  const data = await gpsResponse.clone().json();

  if (!data.ok) return gpsResponse;

  // Pegamos a linha do parâmetro da URL.
  // Exemplo: /api/vehicles?linha=0401 ou /api/vehicles?linha=0.401
  const linhaOriginal = String(url.searchParams.get('linha') || '').trim();
  const linhaNormalizada = normalizeLineText(linhaOriginal);

  let vehicles = data.vehicles || [];

  if (linhaNormalizada) {
    // Aqui estava o problema: antes era uma comparação exata.
    // Agora o backend aceita variações com zero na frente, ponto e sem ponto.
    vehicles = vehicles.filter((vehicle) =>
      matchesLine(vehicle.linha, linhaOriginal)
    );
  }

  return jsonResponse({
    ok: true,
    source: data.source,
    updatedAt: data.updatedAt,
    updatedAtMs: data.updatedAtMs,
    linha: linhaOriginal || null,
    linhaNormalizada: linhaNormalizada || null,
    total: vehicles.length,
    vehicles,
  });
}

function health() {
  return jsonResponse({
    ok: true,
    name: 'DFTrans GPS Proxy - Cloudflare Pages Function',
    status: 'online',
    routes: {
      health: '/health',
      gps: '/api/dftrans-gps',
      vehicles: '/api/vehicles',
      vehiclesByLine: '/api/vehicles?linha=143.2',
    },
  });
}

export async function onRequest(context) {
  const request = context.request;
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
        pathname: url.pathname,
        availableRoutes: ['/health', '/api/dftrans-gps', '/api/vehicles'],
      },
      404
    );
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        source: 'Cloudflare Pages Function',
        error: 'Falha ao consultar DFTrans GPS.',
        detail: error?.message || String(error),
        stack: error?.stack || null,
      },
      502
    );
  }
}