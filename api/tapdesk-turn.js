/**
 * Ephemeral TURN credentials for TapDesk.
 *
 * Preferred: Cloudflare Realtime TURN (same Novixa email).
 *   CLOUDFLARE_TURN_KEY_ID
 *   CLOUDFLARE_TURN_API_TOKEN
 *
 * Fallback: Metered.
 *   METERED_APP
 *   METERED_API_KEY
 *
 * An empty array means the phone and the connect page keep their built-in ICE servers.
 */
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    const cloudflare = await cloudflareIce();
    if (cloudflare) {
      res.status(200).json(cloudflare);
      return;
    }
    const metered = await meteredIce();
    res.status(200).json(metered);
  } catch (_) {
    res.status(200).json([]);
  }
};

async function cloudflareIce() {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const token = process.env.CLOUDFLARE_TURN_API_TOKEN;
  if (!keyId || !token) return null;
  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: 86400 }),
    }
  );
  if (!response.ok) return null;
  const data = await response.json();
  return Array.isArray(data.iceServers) && data.iceServers.length ? data.iceServers : null;
}

async function meteredIce() {
  const app = process.env.METERED_APP;
  const key = process.env.METERED_API_KEY;
  if (!app || !key) return [];
  const url = `https://${app}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(key)}`;
  const response = await fetch(url);
  if (!response.ok) return [];
  const servers = await response.json();
  return Array.isArray(servers) ? servers : [];
}
