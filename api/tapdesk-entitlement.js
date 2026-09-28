/**
 * Secure Link trial for one Google account.
 *
 * Vercel env (same Novixa email):
 *   GOOGLE_WEB_CLIENT_ID          Web OAuth client
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *
 * The phone sends a Google ID token once, then a session token.
 * Same Wi-Fi never calls this route.
 */
const GOOGLE_WEB_CLIENT_ID =
  process.env.GOOGLE_WEB_CLIENT_ID ||
  "155454034563-3fbonqhlcskh6n2oke10n7cc18ake8q8.apps.googleusercontent.com";
const REWARDED_PER_DAY = 2;
const SESSION_TTL_SEC = 60 * 60 * 24 * 30;

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, configured: false, error: "POST only" });
    return;
  }

  const configured = Boolean(
    GOOGLE_WEB_CLIENT_ID &&
      process.env.UPSTASH_REDIS_REST_URL &&
      process.env.UPSTASH_REDIS_REST_TOKEN
  );
  if (!configured) {
    res.status(200).json({
      ok: false,
      configured: false,
      signedIn: false,
      trialUsed: false,
      rewardedToday: 0,
      rewardedLimit: REWARDED_PER_DAY,
    });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const action = String(body.action || "status");
    let sub = "";
    let session = typeof body.session === "string" ? body.session : "";

    if (body.idToken) {
      const verified = await googleSub(String(body.idToken));
      if (verified.error) {
        res.status(200).json(empty(verified.error));
        return;
      }
      sub = verified.sub;
      session = await newSession(sub);
    } else if (session) {
      sub = (await redis(["GET", sessionKey(session)])) || "";
      if (!sub) {
        res.status(200).json({
          ...empty("Sign in with Google again. The saved sign-in expired."),
          sessionInvalid: true,
        });
        return;
      }
    } else {
      res.status(200).json({
        ok: true,
        configured: true,
        signedIn: false,
        trialUsed: false,
        rewardedToday: 0,
        rewardedLimit: REWARDED_PER_DAY,
      });
      return;
    }

    const state = await loadUser(sub);
    if (action === "consume_trial") {
      if (state.trialUsed) {
        res.status(200).json(payload(session, state, "This Google account already used its free Secure Link session."));
        return;
      }
      state.trialUsed = true;
      await saveUser(sub, state);
    } else if (action === "consume_reward") {
      const today = utcDay();
      if (state.rewardedDay !== today) {
        state.rewardedDay = today;
        state.rewardedCount = 0;
      }
      if (state.rewardedCount >= REWARDED_PER_DAY) {
        res.status(200).json(payload(session, state, "Today’s video sessions are used. Unlock Secure Link, or come back tomorrow."));
        return;
      }
      state.rewardedCount += 1;
      await saveUser(sub, state);
    }

    res.status(200).json(payload(session, state, ""));
  } catch (_) {
    res.status(200).json(empty("Couldn’t save this to your Google account. Check internet and try again. Nothing was charged."));
  }
};

function empty(error) {
  return {
    ok: false,
    configured: true,
    signedIn: false,
    trialUsed: false,
    rewardedToday: 0,
    rewardedLimit: REWARDED_PER_DAY,
    error,
  };
}

function payload(session, state, error) {
  const today = utcDay();
  const rewardedToday = state.rewardedDay === today ? state.rewardedCount : 0;
  return {
    ok: !error,
    configured: true,
    signedIn: true,
    trialUsed: Boolean(state.trialUsed),
    rewardedToday,
    rewardedLimit: REWARDED_PER_DAY,
    session,
    error: error || undefined,
  };
}

async function googleSub(idToken) {
  const clientId = GOOGLE_WEB_CLIENT_ID;
  const response = await fetch(
    "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken)
  );
  if (!response.ok) return { error: "That Google sign-in expired. Try again." };
  const info = await response.json();
  if (info.aud !== clientId) return { error: "This Google sign-in is for a different app." };
  if (!info.sub) return { error: "Google didn’t confirm the account." };
  return { sub: info.sub };
}

async function loadUser(sub) {
  const raw = await redis(["GET", userKey(sub)]);
  if (!raw) return { trialUsed: false, rewardedDay: "", rewardedCount: 0 };
  try {
    const parsed = JSON.parse(raw);
    return {
      trialUsed: Boolean(parsed.trialUsed),
      rewardedDay: parsed.rewardedDay || "",
      rewardedCount: Number(parsed.rewardedCount) || 0,
    };
  } catch (_) {
    return { trialUsed: false, rewardedDay: "", rewardedCount: 0 };
  }
}

async function saveUser(sub, state) {
  await redis(["SET", userKey(sub), JSON.stringify(state)]);
}

async function newSession(sub) {
  const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  await redis(["SET", sessionKey(token), sub, "EX", SESSION_TTL_SEC]);
  return token;
}

function userKey(sub) {
  return "tapdesk:acct:" + sub;
}

function sessionKey(token) {
  return "tapdesk:sess:" + token;
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

async function redis(command) {
  const response = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.UPSTASH_REDIS_REST_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error("store");
  const data = await response.json();
  return data.result;
}
