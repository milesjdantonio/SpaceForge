# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Plain HTML, CSS and JavaScript (no framework), with MapLibre GL JS (3D map), three.js (the house on the
map and the walkthrough) and Rive (animation). Chosen by the user; see AGENT.md.
Firebase login and private PostgreSQL building storage are connected through the Go API.
The separate Gemma design service uses the contract in contracts/; the interface clearly
reports when that service is not configured.

## Users

- **People with land in mind (primary).** Anyone imagining what could stand on a piece of land: owners,
  buyers, developers. They outline it, generate a building designed for that exact site, save it, and
  share it.
- **Builders and landowners they share with.** The people a design is sent to by link, to talk it
  through or price it. They don't need an account to open it.

(Decided 2026-10-24: there is no public catalog, no listings and no in-app inquiries. Save it, then
share it with a builder or landowner.)

## Product Purpose

TerraSim turns a patch of land into a building that belongs there. A user outlines a site on a map,
describes the building (style, size, rooms, floors, budget, materials), and Gemma generates a design for
that specific site. Every design carries its predicted build cost, materials list and cost over time
(maintenance, appreciation, depreciation). Success: going from a blank plot to a credible, priced
design in minutes, saved, and sent by link to the builder or landowner who can take it further.

## Positioning

The design starts from the land, not from a plan book. The site's real shape, size, slope, orientation
and surroundings shape the house, and the numbers (cost, materials, cost over time) come attached to
the design rather than as an afterthought.

## Operating Context

- Someone at a desk scouting plots, or on a call with a landowner, drawing a site and iterating on
  inputs, then sending the design.
- Someone on a phone, outlining a lot they drove past and sending the result to a builder or a friend.
- A builder or landowner opening a shared link and reading the plans, cost and long-term numbers.

## Capabilities and Constraints

- Draw or select an arbitrary polygon on a map and read back its geometry for the backend.
- Design inputs: style, size, rooms, floors, budget, materials and similar.
- Outputs per design: description, layout, predicted build cost, materials list, cost-over-time series.
- Every design is private to whoever made it; Share makes a link that carries the building itself
  (or a file for very large ones), and the Share panel keeps every link made.
- Units toggle between imperial (sq ft, acres) and metric (m², hectares); prices in USD.
- Open (see AGENT.md): map provider for production, Gemma model variant, generation service
  boundaries.
- No API keys, model names or provider config may be invented; placeholders are marked.

## Brand Commitments

- Name: **TerraSim** (renamed from SpaceForge on 2026-10-24; the GitHub repo is milesjdantonio/TerraSim).
- The interface is map-first (the user's direction, 2026-10-24): the whole background is the map, the
  home screen is the globe, and the house is shown as an actual building on the land, not a
  blueprint. Panels float over the map. The earlier "Blueprint + Forge" look was dropped.

## Evidence on Hand

- No real users, testimonials, press, partner builders or business numbers exist.
- Exactly one sample house (`frontend/fixtures/mock-house/`) exists for testing. It is labelled as a
  sample wherever it appears and is never presented as a design generated for the user's land.

## Product Principles

1. **The land comes first.** Every design visibly answers to its site: its shape, size, slope and sun.
2. **Numbers travel with the design.** Cost, materials and cost over time are part of the design, never
   hidden behind a click.
3. **Private until shared.** A design is its maker's to look at and send; nothing is listed publicly.
4. **Honest estimates.** Predictions say what they are based on and how certain they are, and say
   so when site data is estimated (outside the US).

## Accessibility & Inclusion

No product-specific requirement was established. Work to WCAG 2.2 AA, keyboard-operable drawing and
forms, and reduced-motion fallbacks for every animation.
