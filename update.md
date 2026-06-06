# Skylight Improvement Plan

This document lists practical feature ideas and implementation notes for improving the Skylight open-source project. The focus is to make the project easier for normal users to install, configure, debug, and enjoy at home.

Skylight already has a strong core: it renders live aircraft overhead using ADS-B data, supports API and RTL-SDR radio modes, includes a real sky layer, and provides a mobile control panel. The updates below build on that foundation.

---

## Priority Summary

### Highest priority

1. First-run setup wizard with location picker
2. Anti-flicker aircraft memory system
3. Diagnostics/status page
4. Better mobile control panel
5. Raspberry Pi one-command installer

### Medium priority

6. Home mode and airport mode presets
7. Aircraft filter panel
8. Projector calibration tool
9. Web-based config editor
10. Flight details popup

### Nice-to-have

11. Closest aircraft alert
12. Flight path history controls
13. Home dashboard mode
14. Screensaver and sleep schedule
15. Privacy mode
16. Better UK/user-friendly documentation

---

# 1. First-Run Setup Wizard

## Problem

New users currently need to manually edit config files for location, radius, display settings, and data source. This is not beginner-friendly.

## Goal

Create a first-run wizard that appears when no saved config exists or when the user opens `/setup`.

## Suggested flow

1. Welcome screen
2. Choose data source: API or RTL-SDR radio
3. Set location using map, postcode/city search, or manual latitude/longitude
4. Choose radius
5. Choose display preset: Home, Airport, Minimal, Debug
6. Projector setup: rotation, mirror X/Y, brightness
7. Save configuration
8. Test aircraft feed

## Suggested fields

```ts
centerLat: number;
centerLon: number;
radiusMiles: number;
dataSource: "api" | "radio";
theme: "ambient" | "telemetry" | "focus";
mirrorX: boolean;
mirrorY: boolean;
rotationDeg: number;
showLabels: boolean;
showTrails: boolean;
```

## Acceptance criteria

- User can configure Skylight without manually editing `config.ts` or `config.json`.
- Saved config persists after restart.
- User can re-open the wizard later from the control panel.

---

# 2. Location Picker With Map

## Problem

Users may not know their latitude and longitude. Manual coordinates caused confusion during setup.

## Goal

Add a visual map picker where users can click their location and save coordinates.

## Suggested features

- Click map to set `centerLat` and `centerLon`.
- Search by city/postcode if possible.
- Show current configured center point.
- Show radius circle around selected location.
- Save directly to persisted config.

## Optional

Add airport presets:

```ts
const airportPresets = [
  { code: "LHR", name: "London Heathrow", lat: 51.4700223, lon: -0.4542955 },
  { code: "LGW", name: "London Gatwick", lat: 51.1537, lon: -0.1821 },
  { code: "LCY", name: "London City", lat: 51.5053, lon: 0.0553 },
  { code: "MAN", name: "Manchester", lat: 53.3650, lon: -2.2722 },
  { code: "BHX", name: "Birmingham", lat: 52.4539, lon: -1.7480 }
];
```

## Acceptance criteria

- User can select a location from UI.
- Config updates immediately.
- Display view reflects the new location after save/reload.

---

# 3. Home Mode and Airport Mode Presets

## Problem

Different users need different display behaviour. A home ceiling display should not look like a busy flight radar screen.

## Goal

Add simple display presets.

## Suggested presets

### Home Mode

Best for a ceiling display above a house.

```ts
radiusMiles: 5,
hideOnGround: true,
showLabels: true,
showTrails: true,
labelDensity: "medium",
staleSec: 120,
maxExtrapolationSec: 60,
theme: "focus"
```

### Airport Mode

Best near airports such as Heathrow.

```ts
radiusMiles: 15,
hideOnGround: false,
showLabels: true,
showTrails: true,
labelDensity: "high",
staleSec: 120,
maxExtrapolationSec: 60,
theme: "telemetry"
```

### Minimal Mode

Best for a clean projector look.

```ts
radiusMiles: 8,
hideOnGround: true,
showLabels: false,
showTrails: true,
labelDensity: "low",
theme: "ambient"
```

### Debug Mode

Best for troubleshooting.

```ts
showHud: true,
showLabels: true,
showTrails: true,
labelDensity: "all",
staleSec: 300,
maxExtrapolationSec: 120,
theme: "telemetry"
```

## Acceptance criteria

- User can choose a preset from control panel.
- Preset updates relevant config values.
- User can still manually override individual settings later.

---

# 4. Anti-Flicker Aircraft Memory System

## Problem

In API mode, aircraft can disappear briefly even when `/api/aircraft` still returns data. This happens because the frontend renderer fades tracks when updates become stale or websocket updates pause briefly.

## Goal

Keep aircraft visually stable during short API/websocket gaps.

## Suggested config

```ts
aircraftMemorySec: 120,
fadeOutSec: 30,
hideOnlyAfterSec: 180,
showStaleIndicator: true
```

## Suggested logic

- Keep aircraft in the track map for `aircraftMemorySec` after the last update.
- Do not fade aircraft immediately when a single update misses them.
- If stale, mark as estimated rather than removing instantly.
- Fade slowly after `fadeOutSec`.
- Remove only after `hideOnlyAfterSec`.

## Example logic

```ts
const ageSec = (now - tr.lastSeen) / 1000;

if (ageSec < cfg.aircraftMemorySec) {
  tr.visible = true;
  tr.estimated = ageSec > cfg.staleSec;
} else if (ageSec < cfg.hideOnlyAfterSec) {
  tr.life = fadeOut(ageSec, cfg.aircraftMemorySec, cfg.hideOnlyAfterSec);
} else {
  removeTrack(tr.hex);
}
```

## UI indicator

Show a small status when data is estimated:

```text
Estimated position · last update 18s ago
```

## Acceptance criteria

- Aircraft no longer disappear for short gaps in API/websocket updates.
- Debug HUD shows stale/estimated track count.
- User can tune memory and fade settings.

---

# 5. Aircraft Filter Panel

## Problem

Busy areas such as London Heathrow can show too many aircraft, ground vehicles, and airport traffic.

## Goal

Let users control exactly what appears on the display.

## Suggested filters

```ts
hideOnGround: boolean;
showOnlyAirborne: boolean;
showArrivals: boolean;
showDepartures: boolean;
showOverheadOnly: boolean;
showHelicopters: boolean;
showCommercialOnly: boolean;
selectedAirlines: string[];
selectedAirports: string[];
minAltitudeFt: number;
maxAltitudeFt: number;
minDistanceMiles: number;
maxDistanceMiles: number;
```

## Useful filter presets

### Clean Home View

```ts
hideOnGround: true,
showCommercialOnly: false,
maxDistanceMiles: 8
```

### Heathrow Arrivals

```ts
selectedAirports: ["LHR"],
showArrivals: true,
hideOnGround: true
```

### Helicopter Watch

```ts
showHelicopters: true,
showCommercialOnly: false
```

## Acceptance criteria

- Filters work live without restart.
- Filter state persists.
- HUD shows filtered aircraft count and total aircraft count.

---

# 6. “What Plane Is Above Me?” Mode

## Problem

Users want to know what aircraft they are hearing or seeing above their home.

## Goal

Highlight the aircraft closest to the user or closest to overhead.

## Suggested calculation

For each aircraft:

```ts
horizontalDistance = distance(centerLat, centerLon, aircraft.lat, aircraft.lon);
altitude = aircraft.altGeom || aircraft.altBaro;
score = horizontalDistance;
```

The lowest score is the closest overhead aircraft.

## Display card

```text
Closest aircraft now
British Airways BA123
Airbus A320neo
LHR → MAD
Altitude: 8,000 ft
Speed: 275 kt
Distance: 2.1 miles
```

## Acceptance criteria

- Automatically highlights closest aircraft.
- Shows readable information card.
- Can be toggled on/off from control panel.

---

# 7. Closest Aircraft Alert

## Problem

Users may miss interesting aircraft passing nearby.

## Goal

Show subtle alerts when notable aircraft pass close to the configured location.

## Alert types

```text
Closest aircraft now
Lowest aircraft nearby
Helicopter nearby
Large aircraft nearby
ISS overhead soon
New airline seen today
```

## Suggested config

```ts
alertsEnabled: boolean;
closestAircraftAlertMiles: number;
lowAircraftAlertFt: number;
alertCooldownSec: number;
```

## Acceptance criteria

- Alerts do not spam the screen.
- Alerts can be disabled.
- Alert threshold can be changed.

---

# 8. Better Mobile Control Panel

## Problem

For a ceiling projector setup, users will often control the display from a phone.

## Goal

Make the control page mobile-first and easier to use.

## Suggested controls

- Theme switcher
- Radius slider
- Label toggle
- Trail toggle
- Aircraft filters
- Brightness slider
- Rotation slider
- Mirror X/Y toggles
- Pause/resume display
- Focus closest aircraft
- Toggle HUD
- Toggle sky layer
- Toggle satellites/ISS

## Suggested layout

```text
Display
Aircraft
Sky
Projector
Data Source
Diagnostics
Advanced
```

## Acceptance criteria

- Works well on phone screen.
- Controls update the display live.
- Config persists after restart.

---

# 9. Projector Calibration Tool

## Problem

Ceiling projection needs careful alignment. Users need to rotate, mirror, scale, and position the image.

## Goal

Add a calibration screen for projector setup.

## Features

- Grid overlay
- Center crosshair
- Corner markers
- Rotation control
- Mirror X/Y
- Scale control
- Offset X/Y
- Brightness test
- Text readability test
- Safe area border

## Suggested route

```text
/calibrate
```

## Suggested config

```ts
projectorScale: number;
projectorOffsetX: number;
projectorOffsetY: number;
rotationDeg: number;
mirrorX: boolean;
mirrorY: boolean;
brightness: number;
```

## Acceptance criteria

- User can align the projection without editing code.
- Calibration settings persist.
- Calibration can be opened from the control panel.

---

# 10. Web-Based Config Editor

## Problem

Users currently may need to edit config files directly.

## Goal

Create a proper settings UI that edits and saves config.

## Suggested sections

### Location

- Latitude
- Longitude
- Radius
- Location picker
- Airport presets

### Display

- Theme
- Brightness
- Labels
- Trails
- HUD

### Aircraft Filters

- On-ground filter
- Altitude filter
- Airline filter
- Airport filter

### Projector

- Rotate
- Mirror
- Scale
- Offset

### Data Source

- API mode
- Radio mode
- Current connection status

### Advanced

- Stale seconds
- Extrapolation seconds
- Aircraft memory seconds
- Polling interval

## Acceptance criteria

- All common config settings are editable from UI.
- Save/reset buttons work.
- Invalid values show helpful validation messages.

---

# 11. Diagnostics and Status Page

## Problem

Debugging is difficult. Users may not know whether the API, websocket, renderer, or config is the problem.

## Goal

Add a diagnostics page.

## Suggested route

```text
/diagnostics
```

## Suggested metrics

```text
Backend status: online/offline
Frontend websocket: connected/disconnected
Data source: API/radio
Aircraft received: 66
Aircraft visible: 52
Aircraft filtered: 14
Estimated/stale tracks: 3
Last API update: 0.8s ago
Last websocket message: 0.2s ago
Websocket reconnects: 2
Current theme: telemetry
Radius: 25mi
Config path: server/data/config.json
```

## Useful buttons

```text
Reload config
Reset config
Export diagnostics
Clear track memory
Test API feed
Test websocket
```

## Acceptance criteria

- User can identify whether aircraft are missing because of API, filters, stale data, or websocket issue.
- Diagnostics can be copied as JSON for GitHub issues.

---

# 12. Flight Path History

## Problem

Trails make the ceiling display more beautiful and informative, but users need control over trail length.

## Goal

Add configurable flight trails.

## Suggested config

```ts
showTrails: boolean;
trailLengthSec: number;
trailFade: boolean;
selectedAircraftTrailBoost: boolean;
```

## Options

```text
1 minute
5 minutes
15 minutes
30 minutes
```

## Acceptance criteria

- Trails show aircraft movement history.
- Trail length can be changed live.
- Trails fade smoothly.

---

# 13. Aircraft Details Popup

## Problem

Users may want more details about a specific aircraft.

## Goal

Allow click/tap selection of aircraft.

## Details to show

```text
Flight number
Aircraft type
Registration
Airline
Origin
Destination
Altitude
Speed
Heading
Distance from center
Last seen
Data source
```

## Display behaviour

- Click aircraft on desktop.
- Tap aircraft on mobile/tablet.
- In projector mode, show a side card.
- Selected aircraft gets highlighted.

## Acceptance criteria

- User can select and inspect aircraft.
- Selection works without interrupting the main display.
- Selected aircraft remains highlighted until cleared or stale.

---

# 14. Screensaver and Sleep Schedule

## Problem

For home use, users may not want the projector/display running at full brightness all night.

## Goal

Add scheduled display behaviour.

## Suggested config

```ts
scheduleEnabled: boolean;
activeStartTime: string;
activeEndTime: string;
dimAfterTime: string;
sleepWhenNoAircraft: boolean;
sleepAfterNoAircraftMin: number;
```

## Example settings

```text
Turn on: 18:00
Dim after: 23:00
Sleep after no aircraft for: 20 minutes
Wake when aircraft returns: yes
```

## Acceptance criteria

- Display can dim or sleep based on schedule.
- User can configure schedule from control panel.
- Schedule respects local timezone.

---

# 15. Local Privacy Mode

## Problem

Users may share screenshots or videos that expose their home location.

## Goal

Add privacy controls.

## Suggested features

- Hide exact coordinates in UI.
- Round coordinates in diagnostics.
- Hide home marker.
- Hide local address/postcode if added later.
- Screenshot-safe mode.

## Suggested config

```ts
privacyMode: boolean;
roundCoordinates: boolean;
hideCenterMarker: boolean;
hideExactLocationInHud: boolean;
```

## Acceptance criteria

- Screenshots do not reveal exact home location when privacy mode is enabled.
- Diagnostics export can hide sensitive values.

---

# 16. Home Dashboard Mode

## Problem

Some users may want stats, not only the sky display.

## Goal

Add optional dashboard stats.

## Suggested stats

```text
Flights seen today
Aircraft currently visible
Most common airline today
Busiest hour
Lowest aircraft today
Fastest aircraft today
Helicopters seen today
Arrivals vs departures
Most common destination
```

## Suggested route

```text
/dashboard
```

## Acceptance criteria

- Stats are optional and do not clutter projector display.
- Dashboard can be viewed from phone or desktop.
- Stats reset daily or can be configured.

---

# 17. Better API/Radio Data Source Fallback

## Problem

API mode may temporarily miss aircraft or return incomplete data. Radio mode may also have short gaps depending on reception.

## Goal

Make data handling more resilient.

## Suggested behaviour

- Merge new API response with recent track memory.
- Keep aircraft if missing for only one or two update cycles.
- Mark missing-but-recent aircraft as estimated.
- Prefer radio data when available.
- Use API only as supplement in radio mode.

## Suggested metadata

```ts
dataSource: "api" | "radio" | "merged";
lastApiSeen: number;
lastRadioSeen: number;
estimated: boolean;
missingUpdateCount: number;
```

## Acceptance criteria

- Aircraft do not flicker due to one missing API response.
- UI can show whether a track is live or estimated.
- Radio mode remains primary when available.

---

# 18. Raspberry Pi One-Command Installer

## Problem

A proper home setup on Raspberry Pi requires many manual steps.

## Goal

Create a one-command installer for Raspberry Pi.

## Suggested command

```bash
curl -sSL https://raw.githubusercontent.com/cpaczek/skylight/main/scripts/install-pi.sh | bash
```

## Installer tasks

```text
Install system packages
Install Node LTS
Install pnpm
Clone or update Skylight
Install dependencies
Create config file
Set data source
Install dump1090/RTL-SDR tools if selected
Create systemd service
Set Chromium kiosk mode
Enable auto-start on boot
```

## Suggested installer questions

```text
Use API mode or RTL-SDR radio mode?
Enter latitude
Enter longitude
Enter radius
Enable kiosk mode?
Enable auto-start?
```

## Acceptance criteria

- Fresh Raspberry Pi can be configured with one command.
- Installer is idempotent and safe to re-run.
- User gets clear success/failure messages.

---

# 19. Better Documentation for Beginners

## Problem

Users may hit common setup issues.

## Goal

Add beginner-friendly documentation.

## Suggested docs

```text
docs/windows-setup.md
docs/raspberry-pi-setup.md
docs/projector-setup.md
docs/rtl-sdr-setup.md
docs/troubleshooting.md
docs/configuration.md
```

## Common troubleshooting topics

```text
pnpm is not recognized
PowerShell running scripts is disabled
Web build not found
Still showing SFO map
Flights disappear but API still has data
No aircraft showing
How to set location
How to run API mode
How to run radio mode
How to use port 5173 vs 3000
```

## Acceptance criteria

- A beginner can run the project on Windows using API mode.
- A beginner can set location without asking for help.
- Common errors have clear fixes.

---

# 20. UK and Airport Example Configs

## Problem

Many users want to test quickly around a known airport.

## Goal

Add ready-made example configs.

## Example

```ts
export const londonHeathrowConfig = {
  centerLat: 51.4700223,
  centerLon: -0.4542955,
  radiusMiles: 10,
  hideOnGround: false,
  theme: "telemetry"
};
```

## Suggested examples

```text
London Heathrow
London Gatwick
London City
Manchester
Birmingham
New York JFK
San Francisco SFO
Los Angeles LAX
Dubai DXB
Singapore SIN
```

## Acceptance criteria

- User can pick an airport preset from setup wizard or config editor.
- Presets include sensible radius and filter defaults.

---

# 21. Export/Import Config

## Problem

Users may want to back up their settings or share working setups.

## Goal

Add config export/import.

## Suggested features

- Export config as JSON.
- Import config JSON.
- Validate imported config.
- Reset to default.
- Reset to preset.

## Acceptance criteria

- User can back up working config.
- Invalid config does not break the app.
- Imported config updates display after save.

---

# 22. GitHub Issue Helper

## Problem

When users report bugs, maintainers need useful information.

## Goal

Generate a copyable diagnostic report.

## Suggested report

```text
Skylight version/commit:
OS:
Node version:
pnpm version:
Data source:
Browser:
Aircraft count:
Visible aircraft count:
Websocket connected:
Last API update:
Current config:
Recent errors:
```

## Acceptance criteria

- User can copy one diagnostic block.
- Sensitive location data is hidden when privacy mode is enabled.

---

# 23. Suggested Implementation Order

## Phase 1: Fix real usability problems

1. Anti-flicker aircraft memory system
2. Diagnostics/status page
3. Web-based config editor for location/radius/theme
4. Beginner troubleshooting docs

## Phase 2: Improve home setup

5. First-run setup wizard
6. Location picker with map
7. Home/Airport/Debug presets
8. Mobile control panel improvements
9. Projector calibration tool

## Phase 3: Improve Raspberry Pi experience

10. Raspberry Pi installer
11. Kiosk auto-start setup
12. RTL-SDR setup helper
13. API/radio status panel

## Phase 4: Add richer user features

14. What plane is above me mode
15. Closest aircraft alerts
16. Flight details popup
17. Flight path history controls
18. Home dashboard mode

## Phase 5: Polish and sharing

19. Privacy mode
20. Export/import config
21. Airport presets
22. GitHub issue helper

---

# 24. Suggested Codex Task Prompts

Use these as smaller tasks in Codex instead of asking it to do everything at once.

## Task 1: Add anti-flicker aircraft memory

```text
Implement an aircraft memory system in Skylight so aircraft do not visually disappear during short API/websocket gaps. Add config values aircraftMemorySec, fadeOutSec, and hideOnlyAfterSec. Keep stale aircraft visible as estimated tracks until hideOnlyAfterSec. Update renderer logic and HUD/debug info to show stale/estimated count.
```

## Task 2: Add diagnostics page

```text
Create a /diagnostics page showing backend status, websocket status, data source, aircraft count, visible aircraft count, filtered count, stale/estimated count, last API update, last websocket message, reconnect count, current theme, radius, and config values. Add a copy diagnostics button.
```

## Task 3: Add config editor

```text
Add a settings/config editor page to update centerLat, centerLon, radiusMiles, theme, mirrorX, mirrorY, rotationDeg, showHud, showLabels, showTrails, hideOnGround, staleSec, and maxExtrapolationSec. Save changes to the existing persisted config and update the display live.
```

## Task 4: Add setup wizard

```text
Add a first-run setup wizard that appears when no persisted config exists. Steps: welcome, data source, location, radius, display preset, projector calibration basics, save and test aircraft feed.
```

## Task 5: Add projector calibration

```text
Create a /calibrate page with a grid overlay, center crosshair, corner markers, rotation control, mirror X/Y toggles, scale control, offset X/Y controls, and brightness test. Save calibration values to config and apply them to the renderer.
```

## Task 6: Add presets

```text
Add display presets: Home Mode, Airport Mode, Minimal Mode, and Debug Mode. Each preset should update radius, theme, hideOnGround, labels, trails, staleSec, maxExtrapolationSec, and label density. Presets should be selectable from the control panel.
```

## Task 7: Improve docs

```text
Create beginner docs for Windows API setup, Raspberry Pi setup, projector setup, RTL-SDR setup, configuration, and troubleshooting. Include fixes for pnpm not recognized, PowerShell script disabled, Web build not found, still showing SFO, flights disappearing, and no aircraft showing.
```

---

# 25. Notes From Testing

These issues were observed during local testing:

## Issue: pnpm not recognized

Fix:

```powershell
npm install -g pnpm
```

or:

```powershell
corepack enable
corepack prepare pnpm@latest --activate
```

## Issue: PowerShell script execution disabled

Temporary fix:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

## Issue: Still showing SFO after changing location

Likely cause:

```text
server/data/config.json contains persisted SFO config
```

Fix:

```text
Update or delete server/data/config.json
```

## Issue: Flights disappear but API still has aircraft

Observation:

```text
/api/aircraft still returns data while frontend hides aircraft
```

Likely cause:

```text
Frontend renderer track staleness, websocket drops/reconnects, or visual fade logic
```

Suggested fix:

```ts
staleSec: 120,
maxExtrapolationSec: 60,
aircraftMemorySec: 120,
fadeOutSec: 30,
hideOnlyAfterSec: 180
```

## Issue: Web build not found on port 3000

Fix:

```powershell
pnpm build
$env:DATA_SOURCE="api"
pnpm start
```

---

# 26. Final Recommendation

The best first contribution is not a flashy new visual effect. It should be reliability and setup improvement.

Recommended first pull request:

```text
Add anti-flicker aircraft memory + diagnostics page
```

Why this first:

- It solves a real issue seen during testing.
- It helps both API and radio users.
- It makes future debugging easier.
- It is smaller than a full setup wizard.
- It gives the project a more polished user experience.

Recommended second pull request:

```text
Add setup/config editor with location and radius controls
```

Recommended third pull request:

```text
Add Raspberry Pi beginner installer and documentation
```

