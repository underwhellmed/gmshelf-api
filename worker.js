const API_VERSION = "2.2.0";

/*
  Both game repos are far too big for jsDelivr (seraph ~13 GB, truffled ~250 MB,
  jsDelivr's limit is 50 MB per package), which is what caused the
  "Failed to fetch version info" / 403 errors. So:
    - catalogs are read straight from raw.githubusercontent.com (no size limit)
    - games are played through raw.githack.com, which serves raw GitHub files
      with the correct content-types so the html actually runs
  If you ever host the games somewhere else, change playBase below.
*/
const SOURCES = {
  seraph: {
    catalog: "https://raw.githubusercontent.com/gmshelf/seraph/main/seraph.json",
    playBase: "https://raw.githack.com/gmshelf/seraph/main/",
    coverBase: "https://raw.githubusercontent.com/gmshelf/seraph/main/covers/",
    coverExt: "jpg"
  },
  truffled: {
    catalog: "https://raw.githubusercontent.com/gmshelf/truffled/main/truffled.json",
    playBase: "https://raw.githack.com/gmshelf/truffled/main/",
    coverBase: "https://raw.githubusercontent.com/gmshelf/truffled/main/covers/",
    coverExt: "webp"
  }
};

const UPSTREAM_TIMEOUT_MS = 8000;

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Accept-Language": "en-US,en;q=0.9"
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extra
    }
  });
}

async function fetchJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { Accept: "application/json", "User-Agent": "gmshelf-api" },
    cf: { cacheTtl: 600, cacheEverything: true }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }

  // raw.githubusercontent serves json as text/plain, so parse manually
  return JSON.parse(await response.text());
}

function extractList(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];

  for (const key of ["games", "items", "data", "results", "catalog", "list", "entries"]) {
    if (Array.isArray(data[key])) return data[key];
  }

  const values = Object.values(data);

  if (
    values.length &&
    values.every(v => v && typeof v === "object" && !Array.isArray(v))
  ) {
    return values;
  }

  return [];
}

// Catalog paths look like "/seraph/slope/index.html". They are relative to the
// repo root, so strip the leading slash and join onto the play base.
function playUrl(raw, base) {
  if (!raw) return "";
  const value = String(raw).trim();
  if (/^https?:\/\//i.test(value)) return value;
  return base + encodeURI(value.replace(/^\/+/, ""));
}

// "/seraph/slope/index.html" -> "slope"
function folderOf(raw) {
  const parts = String(raw || "").split("?")[0].split("/").filter(Boolean);
  return parts.length >= 3 ? parts[parts.length - 2] : "";
}

function isPlaceholderImage(value) {
  return !value || /placeholder/i.test(String(value));
}

function normalizeGame(item, source, index) {
  if (!item || typeof item !== "object") return null;

  const cfg = SOURCES[source];

  const name = String(
    item.name || item.title || item.gameName || item.id || item.slug || ""
  ).trim().slice(0, 200);

  if (!name) return null;

  const rawUrl =
    item.url || item.gameUrl || item.game_url || item.path || item.file || item.href || "";

  const rawImg =
    item.cover || item.img || item.image || item.thumbnail || item.thumb || item.icon || "";

  // Use the repo's own cover when it has one (guessed from the game's folder).
  // If that file doesn't exist the site falls back to /api/cover (image search).
  let cover = "";
  if (!isPlaceholderImage(rawImg)) {
    cover = playUrl(rawImg, cfg.playBase);
  } else {
    const folder = folderOf(rawUrl);
    if (folder) cover = `${cfg.coverBase}${encodeURIComponent(folder)}.${cfg.coverExt}`;
  }

  const slug = String(item.id || item.slug || name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return {
    id: `${source}-${slug || index}`,
    name,
    url: playUrl(rawUrl, cfg.playBase),
    cover,
    source
  };
}

async function loadSource(source) {
  const data = await fetchJson(SOURCES[source].catalog);
  const list = extractList(data);

  if (!list.length) {
    throw new Error(`${source} catalog loaded, but no game list was found`);
  }

  return list
    .map((item, index) => normalizeGame(item, source, index))
    .filter(Boolean);
}

async function loadCatalogs(source = "all") {
  const selected = source === "all" ? Object.keys(SOURCES) : [source];

  const results = await Promise.allSettled(selected.map(loadSource));

  const games = [];
  const errors = [];
  const sources = {};

  results.forEach((result, index) => {
    const name = selected[index];

    if (result.status === "fulfilled") {
      sources[name] = { ok: true, count: result.value.length };
      games.push(...result.value);
    } else {
      const message = result.reason?.message || "unknown source error";
      sources[name] = { ok: false, count: 0, error: message };
      errors.push({ source: name, error: message });
    }
  });

  const unique = [
    ...new Map(games.map(game => [game.url || game.id, game])).values()
  ];

  return { games: unique, errors, sources };
}

/* ---------- cover image search ---------- */

// DuckDuckGo image search: grab a token from the html page, then ask i.js.
async function searchDuckDuckGo(query) {
  const q = encodeURIComponent(query);

  const page = await fetch(`https://duckduckgo.com/?q=${q}&iax=images&ia=images`, {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: BROWSER_HEADERS
  });
  if (!page.ok) return null;

  const vqd = (await page.text()).match(/vqd=["']?([\d-]+)/)?.[1];
  if (!vqd) return null;

  // p=1 keeps safe search on
  const res = await fetch(
    `https://duckduckgo.com/i.js?l=us-en&o=json&q=${q}&vqd=${vqd}&f=,,,,,&p=1`,
    {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: {
        ...BROWSER_HEADERS,
        Accept: "application/json",
        Referer: "https://duckduckgo.com/"
      }
    }
  );
  if (!res.ok) return null;

  const data = await res.json();
  const hit = (data.results || []).find(r => /^https:\/\//.test(r.thumbnail || ""));
  return hit?.thumbnail || null;
}

// Bing image search fallback: thumbnail urls are embedded in the result html.
async function searchBing(query) {
  const res = await fetch(
    `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC3&adlt=strict`,
    { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), headers: BROWSER_HEADERS }
  );
  if (!res.ok) return null;

  const html = await res.text();
  const match = html.match(/turl&quot;:&quot;(https:[^"]+?)&quot;/);
  if (!match) return null;

  return match[1].replace(/&amp;/g, "&");
}

async function findCover(name) {
  const query = `${name} game logo`;

  for (const search of [searchDuckDuckGo, searchBing]) {
    try {
      const image = await search(query);
      if (image) return image;
    } catch {
      // try the next search engine
    }
  }

  return null;
}

function escapeXml(text) {
  return text.replace(/[<>&"']/g, c => (
    { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]
  ));
}

// Generated placeholder so an <img> never ends up broken.
function placeholderCover(name) {
  const words = name.split(/\s+/).filter(Boolean);
  const initials = escapeXml(
    (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase()
  );
  const label = escapeXml(name.length > 26 ? name.slice(0, 25) + "…" : name);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="#2a2a2a"/><stop offset="1" stop-color="#0c0c0c"/>` +
    `</linearGradient></defs>` +
    `<rect width="400" height="300" fill="url(#g)"/>` +
    `<text x="200" y="165" text-anchor="middle" font-family="system-ui,sans-serif" ` +
    `font-size="96" font-weight="800" fill="#f5f5f5" fill-opacity=".9">${initials}</text>` +
    `<text x="200" y="250" text-anchor="middle" font-family="system-ui,sans-serif" ` +
    `font-size="18" fill="#f5f5f5" fill-opacity=".5">${label}</text></svg>`;

  return new Response(svg, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600"
    }
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ ok: false, error: "method not allowed" }, 405);
    }

    if (path === "/" || path === "/api") {
      return json({
        ok: true,
        name: "gmshelf",
        version: API_VERSION,
        authentication: false,
        endpoints: {
          health: "GET /api/health",
          games: "GET /api/games?source=all&search=&limit=300",
          cover: "GET /api/cover?name=mario"
        }
      });
    }

    if (path === "/api/health") {
      return json({
        ok: true,
        service: "gmshelf",
        version: API_VERSION,
        time: new Date().toISOString()
      });
    }

    if (path === "/api/games") {
      const source = (url.searchParams.get("source") || "all").toLowerCase();

      if (!["all", ...Object.keys(SOURCES)].includes(source)) {
        return json({
          ok: false,
          error: "source must be all, seraph, or truffled"
        }, 400);
      }

      const search = (url.searchParams.get("search") || "").trim().toLowerCase();

      const requestedLimit = Number(url.searchParams.get("limit") || 300);
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(1000, Math.floor(requestedLimit)))
        : 300;

      try {
        const result = await loadCatalogs(source);

        const filtered = result.games.filter(game =>
          !search ||
          game.name.toLowerCase().includes(search) ||
          game.id.toLowerCase().includes(search)
        );

        const games = filtered.slice(0, limit);
        const nothingLoaded = result.games.length === 0 && result.errors.length > 0;

        return json({
          ok: !nothingLoaded,
          source,
          search: search || null,
          count: games.length,
          total: filtered.length,
          limit,
          sources: result.sources,
          errors: result.errors,
          games
        }, nothingLoaded ? 502 : 200);
      } catch (error) {
        return json({
          ok: false,
          error: error.message || "catalog request failed",
          games: [],
          total: 0
        }, 502);
      }
    }

    if (path === "/api/cover") {
      const name = (url.searchParams.get("name") || "").trim();

      if (!name || name.length > 120) {
        return json({ ok: false, error: "provide a valid game name" }, 400);
      }

      const image = await findCover(name);

      if (image) {
        return new Response(null, {
          status: 302,
          headers: {
            ...CORS_HEADERS,
            Location: image,
            "Cache-Control": "public, max-age=86400"
          }
        });
      }

      return placeholderCover(name);
    }

    return json({ ok: false, error: "endpoint not found", path }, 404);
  }
};
