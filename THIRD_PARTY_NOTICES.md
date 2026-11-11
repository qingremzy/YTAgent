# Third-party engineering references

## Open Generative AI

- Project: https://github.com/Anil-matcha/Open-Generative-AI
- Author/maintainer: Anil Chandra Naidu Matcha and Open Generative AI contributors
- Upstream license: MIT
- Reference area reviewed: `packages/studio/src/utils/generationLifecycle.js` and `packages/studio/src/muapi.js`

YTAgent's provider lifecycle hardening was independently implemented after reviewing the upstream generation lifecycle approach. The changes normalize provider terminal states, preserve useful provider error details, accept common output URL shapes, and respect `Retry-After` during transient status polling. No MuAPI client, API key, paid model catalog, or upstream studio dependency was imported.

If substantial upstream source code is copied into YTAgent in a future change, include the original MIT copyright and license notice with that copied material.
