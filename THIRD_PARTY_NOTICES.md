# Third-party engineering references

## Open Generative AI

- Project: https://github.com/Anil-matcha/Open-Generative-AI
- Author/maintainer: Anil Chandra Naidu Matcha and Open Generative AI contributors
- Upstream license: MIT
- Reference area reviewed: `packages/studio/src/utils/generationLifecycle.js`, `packages/studio/src/muapi.js`, and `packages/studio/src/components/CinemaStudio.jsx`

YTAgent's provider lifecycle hardening was independently implemented after reviewing the upstream generation lifecycle approach. The changes normalize provider terminal states, preserve useful provider error details, accept common output URL shapes, respect `Retry-After` during transient status polling, and use an original set of deterministic camera/lens prompt presets inspired by Cinema Studio's camera, lens, focal-length, and aperture controls. No Cinema Studio UI or source module was copied. No MuAPI client, API key, paid model catalog, or upstream studio dependency was imported.

If substantial upstream source code is copied into YTAgent in a future change, include the original MIT copyright and license notice with that copied material.
