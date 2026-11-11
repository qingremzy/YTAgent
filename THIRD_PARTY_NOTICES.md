# Third-party engineering references

## Open Generative AI

- Project: https://github.com/Anil-matcha/Open-Generative-AI
- Author/maintainer: Anil Chandra Naidu Matcha and Open Generative AI contributors
- Upstream license: MIT
- Reference area reviewed: `packages/studio/src/utils/generationLifecycle.js`, `packages/studio/src/muapi.js`, and `packages/studio/src/components/CinemaStudio.jsx`

YTAgent's provider lifecycle hardening was independently implemented after reviewing the upstream generation lifecycle approach. The changes normalize provider terminal states, preserve useful provider error details, accept common output URL shapes, respect `Retry-After` during transient status polling, and use an original set of deterministic camera/lens prompt presets inspired by Cinema Studio's camera, lens, focal-length, and aperture controls. No Cinema Studio UI or source module was copied. No MuAPI client, API key, paid model catalog, or upstream studio dependency was imported.

If substantial upstream source code is copied into YTAgent in a future change, include the original MIT copyright and license notice with that copied material.

## Clipkit video editor

YTAgent embeds the open-source `@clipkit/editor` React timeline UI from [clipkit-video/clipkit](https://github.com/clipkit-video/clipkit).

- `@clipkit/editor` 1.1.0 — Apache License 2.0. The full license text is included at `LICENSES/Clipkit-Editor-Apache-2.0.txt`.
- `@clipkit/runtime` 1.4.0 — Business Source License 1.1 (BSL 1.1). The full license text is included at `LICENSES/Clipkit-Runtime-BSL-1.1.txt`.
- The runtime's Additional Use Grant permits embedding it in YTAgent and rendering videos for the product, with a 250-minute monthly production output limit for commercial production use. Personal, educational, and research use is not subject to that volume limit. The runtime is not used to offer a competing hosted Clipkit-rendering service.
- Clipkit's editor and runtime are used as npm dependencies. Their upstream source code is not copied into YTAgent.

Review the upstream [licensing terms](https://github.com/clipkit-video/clipkit/blob/main/LICENSING.md) before changing the deployment's usage pattern or monthly production volume.
