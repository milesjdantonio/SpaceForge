# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Plain HTML, CSS and JavaScript (no framework), with Rive for animation, Leaflet + OpenStreetMap for the
map and Motion (vanilla build) for interface motion. Chosen by the user; see AGENT.md. The backend
(Go accounts service, Python API, Python/R prediction models, Gemma via Google's hosted AI API) does not
exist yet: the frontend runs on a mock layer with the same request and response shapes.

## Users

- **Developers and builders (primary).** Professionals who, with the landowner's permission, draw a real
  plot, generate a house designed for that exact site, and publish it as a listing. They are the people
  an interested buyer contacts.
- **Dreamers.** Anyone curious about what could stand on a piece of land. They can generate a house,
  look at it and share it with a link, but their designs are never published to the catalog and are not
  offered for sale.
- **Browsers / buyers.** People looking through published listings who want to pursue one. They message
  the builder who generated that design.

## Product Purpose

SpaceForge turns a patch of land into a house that belongs there. A user outlines a site on a map,
describes the house (style, size, rooms, floors, budget, materials), and Gemma generates a design for
that specific site. Every design carries its predicted build cost, materials list and cost over time
(maintenance, appreciation, depreciation). Published designs become a catalog that connects buyers to
the builders who made them. Success: a builder can go from a blank plot to a credible, shareable,
priced design in minutes, and a buyer can trust the numbers enough to reach out.

## Positioning

The design starts from the land, not from a plan book. The site's real shape, size, slope, orientation
and surroundings shape the house, and the numbers (cost, materials, cost over time) come attached to
the design rather than as an afterthought.

## Operating Context

- A builder at a desk scouting plots, or on a call with a landowner, drawing a site and iterating on
  inputs.
- A dreamer on a phone, outlining a lot they drove past and sending the result to a friend.
- A buyer browsing listings and comparing cost and long-term numbers before messaging the builder.

## Capabilities and Constraints

- Draw or select an arbitrary polygon on a map and read back its geometry for the backend.
- Design inputs: style, size, rooms, floors, budget, materials and similar.
- Outputs per design: description, layout, predicted build cost, materials list, cost-over-time series.
- Two publishing paths: **private** (dreamer: viewable and shareable by link, never listed) and
  **published listing** (builder: requires confirming the landowner's permission).
- Inquiries go to the builder who generated the design.
- Units toggle between imperial (sq ft, acres) and metric (m², hectares); prices in USD.
- Open (see AGENT.md): map provider for production, data store, auth, Gemma model variant, service
  boundaries, how inquiries are delivered (stored record + email, or in-app messaging).
- No API keys, model names or provider config may be invented; placeholders are marked.

## Brand Commitments

- Name: **SpaceForge**.
- The user chose a "Blueprint + Forge" direction for the web frontend; recorded here as a binding
  constraint, detailed in DESIGN.md.

## Evidence on Hand

- No real users, listings, testimonials, press, partner builders or business numbers exist. Sample
  listings in the frontend are clearly sample data and must not be presented as real customers or
  real sales.
- Cost, materials and cost-over-time figures shown before the prediction models exist come from a
  transparent placeholder estimator in the frontend, labelled as an estimate.

## Product Principles

1. **The land comes first.** Every design visibly answers to its site: its shape, size, slope and sun.
2. **Numbers travel with the design.** Cost, materials and cost over time are part of the design, never
   hidden behind a click.
3. **Permission before publishing.** Nothing is listed for sale without the builder confirming the
   landowner's permission.
4. **Dreaming is free and private.** A dreamer's design is theirs to look at and share, not inventory.
5. **Honest estimates.** Predictions say what they are based on and how certain they are.

## Accessibility & Inclusion

No product-specific requirement was established. Work to WCAG 2.2 AA, keyboard-operable drawing and
forms, and reduced-motion fallbacks for every animation.
