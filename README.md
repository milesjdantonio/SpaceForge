# TerraSim

_Formerly SpaceForge._

TerraSim lets a user draw/highlight an area on a map — an empty city lot, a hillside, any plot of land — and uses an AI model (Gemma, via Google's hosted AI API) to generate a house design for that site. Each generated design is stored along with predicted cost, materials, and cost-over-time projections, so other users can browse past designs, see the numbers behind them, and message the developer directly if they want to buy or build one.

## Core idea

1. **Select a site** — user highlights a region on an interactive map (specific map provider TBD, see [AGENT.md](AGENT.md)).
2. **Describe the house** — user provides inputs: style, size, number of rooms/floors, budget, materials preference, etc.
3. **Generate** — the selected area + inputs are sent to Gemma (via Google's hosted AI API) to produce a house design for that specific site.
4. **Predict** — the system stores/derives predictions: estimated build cost, materials list, and projected cost over time (maintenance, appreciation, etc.).
5. **Browse & contact** — other users can browse generated designs/listings and message the developer directly if they're interested in a specific design.

## Status

Early/hackathon stage. Architecture and integrations are still being decided — see [AGENT.md](AGENT.md) for current decisions, open questions, and how to work on this repo.

## Stack

- **Accounts service:** Go — handles user accounts/auth.
- **API:** Python — the main app API (map/design requests, predictions, inquiries), calls out to Gemma via Google's hosted AI API.
- **Data/analytics:** Python and R — data processing and the cost/materials/cost-over-time prediction models.
- **Frontend:** HTML/CSS/JavaScript, with Rive for interactive/animated UI elements.
- **Map:** provider TBD (Mapbox, Google Maps, or Leaflet/OSM are the candidates)
- **Data store:** TBD — needs to hold users, generated designs, predictions, and contact/inquiry messages

## Getting started

Not yet runnable — no backend/frontend scaffolding exists yet. This section will be filled in once the stack is chosen and the initial scaffold is committed.
