// Public deployment settings. Never put service-account credentials or AI keys here.
const local = ['localhost', '127.0.0.1', '[::1]'].includes(globalThis.location?.hostname);

export const config = {
  // The account API owns generation, projects and private building storage.
  storageBaseUrl: local ? 'http://127.0.0.1:8080' : '',
  get apiBaseUrl() { return this.storageBaseUrl ? `${this.storageBaseUrl}/api` : ''; },
  auth: {
    apiKey: local ? 'local' : '', // Firebase's public web API key in production.
    emulatorUrl: local ? 'http://127.0.0.1:9099' : '', // Leave empty in production.
  },

  // The one sample house (fixtures/mock-house). It can be placed on a
  // drawn lot as a labelled preview. Turn off once real designs exist.
  showSample: true,

  // Place search and place names: OpenStreetMap Nominatim (free for light use, no key). See
  // js/map/places.js. Replace with a hosted geocoder before real traffic.
  geocoder: 'https://nominatim.openstreetmap.org',
  // Search as you type. Nominatim forbids autocomplete, so suggestions come from Photon (komoot's
  // OpenStreetMap search, built for it, no key). Also replace before real traffic.
  typeahead: 'https://photon.komoot.io',

  map: {
    // OpenStreetMap vector style with 3D buildings, from OpenFreeMap (free, no key).
    style: 'https://tiles.openfreemap.org/styles/liberty',
    // Satellite imagery: Esri World Imagery (free with attribution, no key). Check Esri's terms
    // before production use.
    satellite: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    },
    // Ground heights for the walkthrough's view outside: Terrarium elevation tiles from the AWS
    // open terrain dataset (free, no key). Tiles are {z}/{x}/{y}.png under this address.
    terrain: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium',
    // Worldwide 3D buildings: Overture Maps' buildings theme as PMTiles (free, no key). OpenStreetMap
    // plus machine-mapped footprints, so it covers cities where OpenStreetMap is thin. Overture
    // describes these tiles as for inspection rather than a production basemap: host an extract
    // (pmtiles extract) before real traffic. Update the release from Overture's release calendar.
    buildings: {
      url: 'https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/2026-10-21.0/buildings.pmtiles',
      attribution: '© Overture Maps Foundation, OpenStreetMap contributors',
    },
  },
};
