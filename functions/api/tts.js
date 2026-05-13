export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

export async function onRequestPost({ request, env }) {
  try {
    const { text } = await request.json();

    if (!text || typeof text !== "string") {
      return json({ error: "Texto inválido" }, 400);
    }

    if (!env.ELEVENLABS_API_KEY) {
      return json({ error: "ELEVENLABS_API_KEY não configurada" }, 500);
    }

    if (!env.ELEVENLABS_VOICE_ID) {
      return json({ error: "ELEVENLABS_VOICE_ID não configurada" }, 500);
    }

    const cleanText = normalizeInstruction(text);

    const elevenResponse = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${env.ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: cleanText,
          model_id: "eleven_multilingual_v2",
          voice_settings: {
            stability: 0.55,
            similarity_boost: 0.82,
            style: 0.25,
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!elevenResponse.ok) {
      const errorText = await elevenResponse.text();
      return json(
        {
          error: "Erro na ElevenLabs",
          status: elevenResponse.status,
          detail: errorText,
        },
        elevenResponse.status
      );
    }

    return new Response(elevenResponse.body, {
      status: 200,
      headers: {
        ...corsHeaders(),
        "Content-Type": "audio/mpeg",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (error) {
    return json(
      {
        error: "Erro ao gerar voz",
        detail: error?.message || String(error),
      },
      500
    );
  }
}

function normalizeInstruction(text) {
  return String(text)
    .replace(/\s+/g, " ")
    .replace(/DF-061/gi, "DF zero sessenta e um")
    .replace(/DF ?061/gi, "DF zero sessenta e um")
    .replace(/EPAA/gi, "E P A A")
    .replace(/\bkm\b/gi, "quilômetros")
    .replace(/\bm\b/gi, "metros")
    .replace(/\bAv\./gi, "Avenida")
    .replace(/\bSt\./gi, "Setor")
    .trim()
    .slice(0, 450);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json",
    },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}