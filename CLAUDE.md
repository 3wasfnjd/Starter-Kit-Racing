# هجولة (Hajwala)

An Arabic-localized drift/racing game, originally ported from Kenney's "Starter Kit Racing" Godot 4.6 project to plain JavaScript and three.js with crashcat physics, since substantially expanded (AR mode, AI opponents, lap timer, track editor).

## Structure

- `index.html` — Game entry point (menu, mode selection, boot-error overlay)
- `editor.html` — Standalone track editor (build/share custom track layouts via `?map=` URL param)
- `js/` — JavaScript source
  - `main.js` — Scene setup, menus, mode flows (NORMAL web + AR room/track/arena), game loop
  - `Physics.js` — crashcat wall colliders and sphere body (ported from Godot collision shapes)
  - `Track.js` — GridMap track layout and piece placement
  - `Vehicle.js` — Vehicle physics and controls
  - `Camera.js` — Camera system
  - `Controls.js` — Keyboard/touch input handling
  - `AIController.js` — Race and free-roam AI driver logic (path-following/lookahead steering)
  - `ARManager.js` — AR session/controller management for Meta Quest passthrough mode
  - `LapTimer.js` — Lap counting, timing, best-lap persistence (localStorage)
  - `DriftMarks.js` — Persistent tire skid-mark trail geometry (serializable)
  - `Particles.js` — Smoke trail effects
  - `Flag.js` — Animated cloth rear-corner flag
  - `Loader.js` — Shared GLTF/colormap texture loading
  - `Audio.js` — Sound: positional sources on the vehicle, distance lowpass, outdoor reverb; engine and impacts are synthesized, skid/horn/reverse/launch are samples. Also loads a crowd-cheer sample (`audio/crowd.mp3`) and background music (`audio/music.mp3`) — see note below.
  - `EngineWorklet.js` — Procedural engine synth (AudioWorklet)
  - `ImpactSound.js` — Procedural collision one-shots (rendered into AudioBuffers at init)
- `models/` — GLB models and shared textures
- `audio/` — Sample assets (skid, horn, reverse, launch, background music; engine and impacts are synthesized instead — see `EngineWorklet.js`/`ImpactSound.js`). **Note:** `Audio.js` also tries to load `audio/crowd.mp3` for a hard-drift crowd cheer, but that file doesn't exist in the repo — the feature fails to load silently (no crash; `crowdSound.buffer` just stays unset) until the asset is added.
- `images/` — Menu UI art (icons, thumbnails, background)
- `sprites/` — Sprite assets (smoke particle texture)

## Key conventions

- GridMap cell size: 9.99 units, scale: 0.75 (`CELL_RAW` and `GRID_SCALE` in `Track.js`)
- Track group has `position.y = -0.5` offset
- Godot vehicle models use `root_scale = 0.5`
- Wall colliders: friction 0.0, restitution 0.1
- Corner colliders: arc center at `(-CELL_HALF, +CELL_HALF)` in local space, outer wall radius `2*CELL_HALF - 0.25`
- Orientation mapping from Godot GridMap indices: `{ 0: 0°, 10: 180°, 16: 90°, 22: 270° }`

## Porting reference

Godot collision shapes are defined in `_godot/models/Library/mesh-library.tscn` as `ConcavePolygonShape3D` vertex data. The JS port approximates these with crashcat cuboid colliders.
