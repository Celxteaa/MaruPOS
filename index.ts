// ============================================================================
// Supabase Edge Function: verify-license
// Backend KHUSUS untuk verifikasi lisensi MaruPOS.
// - Private key penandatanganan HANYA ada di sini (env secret), TIDAK PERNAH
//   dikirim ke client.
// - Tabel `licenses` / `license_activations` diakses pakai service_role key
//   (juga dari env, disuntik otomatis oleh platform Supabase), bukan anon key,
//   sehingga client tidak bisa membaca/menulis tabel ini secara langsung.
// - Deploy dengan:  supabase functions deploy verify-license
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  // Saat production, ganti "*" dengan origin aplikasi Anda untuk keamanan lebih ketat.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Private key ECDSA P-256 dalam format JWK, disimpan sebagai Supabase secret:
//   supabase secrets set LICENSE_PRIVATE_KEY_JWK='{"kty":"EC",...}'
async function getPrivateKey() {
  const jwkStr = Deno.env.get("LICENSE_PRIVATE_KEY_JWK");
  if (!jwkStr) throw new Error("LICENSE_PRIVATE_KEY_JWK belum diset di secrets");
  const jwk = JSON.parse(jwkStr);
  return await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

async function signPayload(payloadStr: string): Promise<string> {
  const key = await getPrivateKey();
  const data = new TextEncoder().encode(payloadStr);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data);
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ valid: false, reason: "Method tidak didukung" }, 405);
  }

  let body: { license_key?: string; device_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ valid: false, reason: "Body request tidak valid" }, 400);
  }

  const licenseKey = (body.license_key || "").trim();
  const deviceId = (body.device_id || "").trim();

  if (!licenseKey || !deviceId) {
    return json({ valid: false, reason: "license_key dan device_id wajib diisi" }, 400);
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    const { data: lic, error: licErr } = await supabase
      .from("licenses")
      .select("*")
      .eq("license_key", licenseKey)
      .maybeSingle();

    if (licErr) {
      console.error(licErr);
      return json({ valid: false, reason: "Kesalahan server saat memeriksa lisensi" }, 500);
    }
    if (!lic) {
      return json({ valid: false, reason: "Kode lisensi tidak ditemukan" });
    }
    if (lic.status !== "active") {
      return json({ valid: false, reason: "Lisensi tidak aktif atau telah dicabut" });
    }
    if (new Date(lic.expires_at).getTime() < Date.now()) {
      return json({ valid: false, reason: "Lisensi telah kadaluarsa" });
    }

    // Cek / catat pengikatan perangkat (device binding)
    const { data: activations, error: actErr } = await supabase
      .from("license_activations")
      .select("device_id")
      .eq("license_key", licenseKey);

    if (actErr) {
      console.error(actErr);
      return json({ valid: false, reason: "Kesalahan server saat memeriksa aktivasi" }, 500);
    }

    const alreadyActivated = (activations ?? []).some((a) => a.device_id === deviceId);

    if (!alreadyActivated) {
      const maxDevices = lic.max_devices ?? 1;
      if ((activations?.length ?? 0) >= maxDevices) {
        return json({
          valid: false,
          reason: `Lisensi ini sudah dipakai di ${maxDevices} perangkat (batas maksimum)`,
        });
      }
      const { error: insErr } = await supabase.from("license_activations").insert({
        license_key: licenseKey,
        device_id: deviceId,
        activated_at: new Date().toISOString(),
        last_verified_at: new Date().toISOString(),
      });
      if (insErr) {
        console.error(insErr);
        return json({ valid: false, reason: "Gagal mendaftarkan perangkat" }, 500);
      }
    } else {
      await supabase
        .from("license_activations")
        .update({ last_verified_at: new Date().toISOString() })
        .eq("license_key", licenseKey)
        .eq("device_id", deviceId);
    }

    const exp = new Date(lic.expires_at).getTime();
    const payload = { key: licenseKey, device_id: deviceId, exp, iat: Date.now() };
    const payloadStr = JSON.stringify(payload);
    const payloadB64 = btoa(payloadStr);
    const signatureHex = await signPayload(payloadStr);
    const token = `${payloadB64}.${signatureHex}`;

    return json({ valid: true, exp, token });
  } catch (e) {
    console.error(e);
    return json({ valid: false, reason: "Kesalahan server: " + (e as Error).message }, 500);
  }
});
