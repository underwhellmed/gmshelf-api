const API_VERSION = "2.1.0";

// Game sources. Each has fallbacks so one upstream hiccup doesn't kill the api.
const SERAPH_CATALOGS = [
  "https://cdn.jsdelivr.net/gh/gmshelf/seraph@main/seraph.json",
  "https://raw.githubusercontent.com/gmshelf/seraph/main/seraph.json"
];
const SERAPH_BASE = "https://cdn.jsdelivr.net/gh/gmshelf/seraph@main/";

// jsdelivr's file listing has no rate limit problem, unlike api.github.com,
// which blocks shared cloudflare worker ips.
const TRUFFLED_LISTINGS = [
  "https://data.jsdelivr.com/v1/packages/gh/gmshelf/truffled@main?structure=flat",
  "https://data.jsdelivr.com/v1/packages/gh/gmshelf/truffled@master?structure=flat"
];
const TRUFFLED_BASE = "https://cdn.jsdelivr.net/gh/gmshelf/truffled@main/";

const UPSTREAM_TIMEOUT_MS = 8000;

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

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: {
      Accept: "application/json",
      "User-Agent": "gmshelf-api",
      ...(options.headers || {})
    },
    cf: { cacheTtl: 600, cacheEverything: true }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }

  return response.json();
}

// Try each url in order, return the first that works.
async function fetchFirst(urls) {
  let lastError = null;

  for (const url of urls) {
    try {
      return await fetchJson(url);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("all upstream requests failed");
}

function extractList(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];

  const possibleKeys = [
    "games", "items", "data", "results", "catalog", "list", "entries"
  ];

  for (const key of possibleKeys) {
    if (Array.isArray(data[key])) return data[key];
  }

  // Some catalogs are objects keyed by game id.
  const values = Object.values(data);

  if (
    values.length &&
    values.every(v => v && typeof v === "object" && !Array.isArray(v))
  ) {
    return values;
  }

  return [];
}

function resolveUrl(raw, base) {
  if (!raw) return "";
  try {
    return new URL(String(raw), base).href;
  } catch {
    return "";
  }
}

function normalizeGame(item, source, index, base) {
  if (!item || typeof item !== "object") return null;

  const name = String(
    item.name || item.title || item.gameName || item.id || item.slug || ""
  ).trim().slice(0, 200);

  if (!name) return null;

  const gameUrl = resolveUrl(
    item.url || item.gameUrl || item.game_url || item.path || item.file || item.href,
    base
  );

  const cover = resolveUrl(
    item.cover || item.img || item.image || item.thumbnail || item.thumb || item.icon,
    base
  );

  const slug = String(item.id || item.slug || name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return {
    id: `${source}-${slug || index}`,
    name,
    url: gameUrl,
    cover,
    source
  };
}

async function loadSeraph() {
  const data = await fetchFirst(SERAPH_CATALOGS);
  const list = extractList(data);

  if (!list.length) {
    throw new Error("seraph.json loaded, but no game list was found");
  }

  return list
    .map((item, index) => normalizeGame(item, "seraph", index, SERAPH_BASE))
    .filter(Boolean);
}

const SKIP_PATH = /(^|\/)(index\.html?|404\.html?|node_modules|\.github|assets|css|js|images|img|fonts)(\/|$)/i;

async function loadTruffled() {
  const data = await fetchFirst(TRUFFLED_LISTINGS);

  const paths = (Array.isArray(data.files) ? data.files : [])
    .map(file => String(file.name || "").replace(/^\/+/, ""))
    .filter(path => /\.html?$/i.test(path) && !SKIP_PATH.test(path));

  if (!paths.length) {
    throw new Error("repository loaded, but no html game files were found");
  }

  return paths.map(path => {
    const filename = path.split("/").pop().replace(/\.html?$/i, "");
    const name = filename
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, char => char.toUpperCase());

    const encoded = path.split("/").map(encodeURIComponent).join("/");

    return {
      id: `truffled-${path.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      name,
      url: TRUFFLED_BASE + encoded,
      cover: "",
      source: "truffled"
    };
  });
}

async function loadCatalogs(source = "all") {
  const selected = source === "all" ? ["seraph", "truffled"] : [source];
  const loaders = { seraph: loadSeraph, truffled: loadTruffled };

  const results = await Promise.allSettled(
    selected.map(name => loaders[name]())
  );

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

async function findCover(name) {
  const endpoint = new URL("https://en.wikipedia.org/w/api.php");

  endpoint.searchParams.set("action", "query");
  endpoint.searchParams.set("generator", "search");
  endpoint.searchParams.set("gsrsearch", `${name} video game`);
  endpoint.searchParams.set("gsrnamespace", "0");
  endpoint.searchParams.set("gsrlimit", "5");
  endpoint.searchParams.set("prop", "pageimages");
  endpoint.searchParams.set("piprop", "thumbnail");
  endpoint.searchParams.set("pithumbsize", "600");
  endpoint.searchParams.set("format", "json");

  const response = await fetch(endpoint.href, {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: {
      Accept: "application/json",
      "User-Agent": "gmshelf-api/2.1"
    },
    cf: { cacheTtl: 86400, cacheEverything: true }
  });

  if (!response.ok) return null;

  const data = await response.json();
  const pages = Object.values(data.query?.pages || {});
  const page = pages.find(item => item.thumbnail?.source);

  return page?.thumbnail?.source || null;
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
      "Cache-Control": "public, max-age=86400"
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

      if (!["all", "seraph", "truffled"].includes(source)) {
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

        // Only a hard failure (nothing loaded at all) is an error status.
        // If one source is down the other still serves, errors explain why.
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

      try {
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
      } catch {
        // fall through to the generated placeholder
      }

      return placeholderCover(name);
    }

    return json({ ok: false, error: "endpoint not found", path }, 404);
  }
};
