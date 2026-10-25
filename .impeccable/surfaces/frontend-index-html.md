---
version: 1
slug: "frontend-index-html"
primary_target: "website/index.html"
related_targets: []
---

## Scope

The TerraSim web interface: the globe home screen, the map where users outline land and send a brief, the house shown on its lot, the side panel, My Builds, Share, and the walkthrough. Generation is done by the Gemma system (contracts/FIELDS.md); the interface only sends and renders.

## Audience and job

Builders and developers (primary) outline a plot they have the landowner's permission for, send it, and publish the result. Dreamers outline land and look privately. Buyers browse listings and contact the builder.

## Direction contract

THESIS: The land is the interface. The whole screen is the real map, from the globe down to the street; the house appears as an actual building standing on the lot among its neighbours. It refuses the listing grid and the blueprint costume.

OWN-WORLD: Satellite imagery and OpenStreetMap 3D buildings as the ground; near-black solid panels float on it; amber only for the main action, the drawn outline and selection. Zodiak for display, Hanken Grotesk for everything practical, tabular figures.

STORY: A visitor sees the Earth, flies to where they are, outlines their land, sends it, and sees the house that would stand there.

FIRST VIEWPORT: The globe centred above the lowercase wordmark and one sentence; the visitor's location pulses; one line says to click to fly there.

FORM: Map-first app, pinned by the user (supersedes the earlier inspection-card roll). seed:29ab18fd27d05ac0

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Unresolved

Production map and imagery terms, place search, auth, inquiry delivery, the real Gemma output.
