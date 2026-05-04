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
      },
      502
    );
  }
}