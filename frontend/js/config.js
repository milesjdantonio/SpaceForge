// Deployment settings. Fill these in when the backend exists; nothing here is a secret.

export const config = {
  // Base URL of the TerraSim API (Python). Empty means "not connected": sending a site fails with a
  // clear message instead of pretending. Example: 'https://api.terrasim.example/v1'
  apiBaseUrl: '',

  // The one sample house (fixtures/mock-house). It appears in the catalog and can be placed on a
  // drawn lot as a labelled preview. Turn off once real designs exist.
  showSample: true,

  // Place search and place names: OpenStreetMap Nominatim (free for light use, no key). See
  // js/map/places.js. Replace with a hosted geocoder before real traffic.
  geocoder: 'https://nominatim.openstreetmap.org',

  map: {
    // OpenStreetMap vector style with 3D buildings, from OpenFreeMap (free, no key).
    style: 'https://tiles.openfreemap.org/styles/liberty',
    // Satellite imagery: Esri World Imagery (free with attribution, no key). Check Esri's terms
    // before production use.
    satellite: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    },
  },
};
