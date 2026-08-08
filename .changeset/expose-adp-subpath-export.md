---
"@deduvafork/squad-sdk": patch
---

fix: expose the adp barrel as a ./adp subpath export

packages/squad-sdk/src/adp/ shipped as a barrel with no matching entry in the
package's exports map, so consumers could not import it at all. Adds the entry
alongside the other barrels, which also restores the sdk-exports-validation CI
gate to green.
