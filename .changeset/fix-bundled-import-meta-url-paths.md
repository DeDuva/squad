---
"@deduvafork/squad-sdk": patch
"@deduvafork/squad-cli": patch
---

fix: resolve remaining import.meta.url paths broken by airgap bundling

Bundling squad-cli into a single dist/squad.js collapses every module's
import.meta.url to the bundle's own location, so path offsets computed for the
unbundled layout resolved to directories that do not exist. The remote-ui
static dir, the loop.md template, the built-in presets dir and the squad agent
template now each try the bundled location as well as the unbundled one, and
squad-cli's postbuild copies the SDK's built-in presets alongside its bundle.
