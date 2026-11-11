# Repository Guidance

## Project shape
- This is a static, browser-based atlas. Keep it dependency-light; Leaflet 1.9.4 is loaded from a CDN in `index.html`.
- `js/app.js` coordinates startup and UI state. Map rendering, markers, and sidebar behavior are separated into `js/map.js`, `js/markers.js`, and `js/sidebar.js` where applicable.
- `data/config.json` defines map dimensions, modes, and image paths. `data/locations.json` contains points of interest.
- `css/style.css` owns the interface styling; map backgrounds are under `assets/maps/`.

## Working conventions
- Preserve the existing vanilla JavaScript and CSS approach; do not introduce a package manager or build step for small changes.
- Keep user-facing text and documentation in Russian, matching the existing interface and README.
- Map coordinates use the source image's top-left origin: X increases rightward and Y downward. Keep map overlays at matching dimensions so markers remain aligned across modes.
- Escape data-derived text before inserting it into HTML, following the existing `escapeHtml` helper in `js/app.js`.

## Run and verify
- JSON is fetched by the browser, so do not use `file://`. Start a local server from the repository root with `python -m http.server 8000`, then open `http://localhost:8000`.
- After changes, check the affected browser workflow in the running app and inspect the browser console for loading or JavaScript errors. For data-only edits, verify JSON parses and referenced mode/image paths exist.
