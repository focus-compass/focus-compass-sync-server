Projects as the app stores them after loading its starter presets
(`focus-compass-app/src/data/presets/*.json` through `loadPreset()`, with ids made
deterministic and the UI-only TRANSIENT_KEYS removed the way `sanitizeData`
does before syncing). Used to check that the strict project schema accepts
real app data without errors or warnings.
