/**
 * Ephemeral TURN credentials for TapDesk Connect.
 * Set METERED_APP and METERED_API_KEY in the Vercel project.
 * Until they are set, clients fall back to built-in static ICE servers.
 */
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const app = process.env.METERED_APP;
  const key = process.env.METERED_API_KEY;
  if (!app || !key) {
    res.status(200).json([]);
    return;
  }

  try {
    const url = `https://${app}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(key)}`;
    const response = await fetch(url);
    if (!response.ok) {
      res.status(200).json([]);
      return;
    }
    const servers = await response.json();
    res.status(200).json(Array.isArray(servers) ? servers : []);
  } catch (_) {
    res.status(200).json([]);
  }
};
