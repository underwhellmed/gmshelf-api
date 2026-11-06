
# gmshelf

A public ubg game catalog API powered by Cloudflare Workers.

Browse games, retrieve game metadata, and use remote covers.

## Features

- Public API with no user authentication
- Seraph and Truffled catalog support
- Game search and filtering
- Remote cover image lookup
- CORS enabled
- Cloudflare caching for upstream requests
- No database or uploaded image files

## Project structure

main/
├── LICENSE
├── index.html
├── worker.js
├── wrangler.toml
└── README.md

## API endpoints

### GET /api

Returns API information and endpoint documentation.

### GET /api/games

Returns the combined game catalog.

### GET /api/games?source=seraph

Returns Seraph games.

### GET /api/games?source=truffled

Returns Truffled games.

### GET /api/games?search=1v1.lol

Searches by game name or ID.

### GET /api/games?limit=300

Limits the returned games.

Maximum limit: 1000.

### GET /api/cover?name=1v1.lol

Looks up a remote game cover and redirects to its image URL.

### POST /api/summary

Generates an AI summary using Groq.

Example request:

{
  "games": [
    {
      "name": "Example Game",
      "source": "seraph",
      "hasCover": true,
      "hasPlayableUrl": true
    }
  ]
}

### GET /api/health

Checks API availability and AI configuration status.

## Game response format

{
  "id": "1v1.lol",
  "name": "1v1.lol",
  "url": "https://example.com/game.html",
  "cover": "https://example.com/cover.jpg",
  "source": "truffled"
}

## Integrating with HTML

const response = await fetch(
  "https://gmshelf-api.workers.dev/api/games"
);

const data = await response.json();

console.log(data.games);

## Cover images

Existing image URLs are preserved from the upstream catalog.

Missing covers are looked up remotely through Wikipedia.

No image files need to be uploaded.

## Important

The API is publicly accessible.

Anyone can retrieve catalog information and call public endpoints.

Upstream catalogs and image providers may change their URLs or availability.

Game embedding is subject to the original hosting site's restrictions.
