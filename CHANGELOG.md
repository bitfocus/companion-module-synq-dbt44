# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.5] - 2026-03-28

### Changed
- Preset definitions moved to `src/presets.js`
- Periodic OSC ping every 30s while connected (keeps reachability checks meaningful)
- Actions call `checkFeedbacks` with specific feedback ids; after a device sync batch, only `input_muted`, `output_muted`, and `matrix_point_muted` are refreshed (not every feedback type)
- Log level `error` for configuration failures, socket errors, sync/ping send failures, and `applySyncVariables` exceptions
- Manifest `version` set to `0.0.0` (release pipeline overrides from `package.json`); search keywords trimmed to user-facing terms only
- `.gitignore` aligned with module template (ignore `.yarn/`, `pkg`, tgz, `DEBUG-*`)

### Removed
- Unused `syncTimer` / periodic sync interval (sync remains on connect and via action)
- `.yarn` directory must not be committed (see `.gitignore`)

## [1.0.4] - 2026-03-28

### Fixed
- CI: removed `package-lock.json`; `yarn.lock` kept in sync with Yarn 4 immutable installs

## [1.0.3] - 2026-03-28

### Fixed
- `package.json` and manifest version fields aligned with git tag for Companion release checks

## [1.0.2] - 2026-03-28

### Fixed
- Merge and lockfile updates after remote dependency changes

## [1.0.1] - 2026-03-28

### Changed
- Aligned repository layout with Bitfocus JS module template (`src/` split, Yarn 4, LICENSE, tooling files)

## [1.0.0] - 2026-02-03

### Added
- Initial release of Synq DBT-44 Companion module
- OSC control via UDP (device receives on port 9000, sends on port 9001)
- Connection management with ping for status monitoring
- Sync functionality to retrieve all current settings from device

### Actions
- Set input gain (matrix): Control gain for any input→output crosspoint (-120 to +10 dB)
- Set output gain: Control overall output gain (-120 to +10 dB)
- Step input gain (matrix): Adjust gain by preset steps (+3 dB, -3 dB, or custom amount)
- Step output gain: Adjust output gain by preset steps (+3 dB, -3 dB, or custom amount)
- Matrix point mute toggle: Toggle mute for any input→output crosspoint (sets gain to -120 dB / restores)
- Set input mute: Mute/unmute/toggle any input channel
- Set output mute: Mute/unmute/toggle any output channel
- Refresh sync: Manually trigger sync to get all settings from device

### Feedbacks
- Input muted: Visual feedback when an input is muted (red background, "MUTED" text)
- Output muted: Visual feedback when an output is muted (red background, "MUTED" text)
- Matrix point muted: Visual feedback when a matrix crosspoint is muted (red background, "MUTE" text)

### Variables
- Device name: Configured device name used in OSC paths
- Dynamic variables: All sync values from device (gain, mute, trim, delay, phase, EQ, compression settings)
- Human-readable variable names: Automatic conversion of OSC paths to readable labels (e.g., "Gain: Analog in 2 → Dante out 1")

### Presets
- 64 ready-made button presets organized in 8 folders (one per output)
- Each preset shows input number and live gain value
- Mute feedback with "In X\nMUTE" display when muted
- Presets ordered by output: Out 1 (In 1-8), Out 2 (In 1-8), etc.

### Configuration
- Host/IP or hostname configuration
- Device name configuration (required for OSC paths)
- Customizable target port (default: 9000)
- Customizable feedback port (default: 9001)
- DNS resolution support for hostnames

### Documentation
- Network limitation documentation: Feedback only works on local network (same subnet)
- Setup instructions in HELP.md
- README with connection details and development information
