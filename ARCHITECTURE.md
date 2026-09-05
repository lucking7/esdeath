# MirrRule Architecture

MirrRule is a rule aggregation pipeline. It downloads upstream rule artifacts, normalizes each line into a shared in-memory rule model, then writes platform-specific outputs for Surge, Clash, Loon, and sing-box.

## Build pipeline

```text
Build/index.ts
  ├─ downloadGEOIP()
  ├─ RuleSourceProcessor
  │   ├─ fetchAssets() / loadRules()
  │   └─ shared ruleset publication
  │       └─ EnhancedFileOutput
  │           └─ createStrategiesForTargets()
  │               ├─ SurgeRuleSet
  │               ├─ ClashClassicRuleSet
  │               ├─ LoonRuleSet
  │               └─ SingboxSource
  └─ buildPublic()
      ├─ public-index-model
      └─ static HTML renderer
```

`EnhancedFileOutput` owns normalization, canonical rule state, finalization, and logical rule summaries. Its state is private; platform writers remain four adapters behind the existing writer seam. `RuleSourceProcessor` retains the same publication interface. Each output instance is finalized once, by either `compile()` or `write()`.

## Upstream artifacts

Mirror sources use release adapters behind one artifact synchronization module. Release assets are filtered before download, validated before publication, and replaced through the shared atomic-file primitive, so a failed download or post-process keeps the last-known-good file. Add another adapter only when a production source requires one.

`NSRingo/Siri` is release-driven. The mirror accepts the `iRingo.Siri`, `iRingo.Search`, and `iRingo.Spotlight` asset families and does not build the upstream `dev` branch.

Source health probes carry the same request profile as their build source. Rule inputs use the Surge User-Agent, while GitHub release metadata uses the mirror User-Agent.

## Plugin artifacts

Plugin conversions remain pending until every required script has a mirrored or cached URL. Canonical source identity follows each plugin through remote conversion, local fallback, cache, and publication. Publication reports `ready`, `degraded`, or `failed`, uses the shared atomic-file primitive, and prevents same-name plugins from sharing cached bytes.

## Public index

`Build/lib/public-index-model.ts` owns rule aggregation, client metadata, visible-file semantics, and deterministic ordering. `Build/build-public.ts` owns HTML and browser behavior and does not mutate the model input.

## Current scope

The current codebase no longer parses raw adblock filter syntax into rules. It consumes upstream rule files and forwards normalized rule-set output by target platform.

Historical adblock parsing code and unused output variants have been removed to keep the build path small and easier to audit.

## Attribution

The project derives part of its build and rule-output code from [SukkaW/Surge](https://github.com/SukkaW/Surge). SukkaW/Surge is licensed under AGPL-3.0; MirrRule is also distributed under AGPL-3.0.
