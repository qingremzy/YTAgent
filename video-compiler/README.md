# YTAgent Video Compiler

The compiler separates AI direction from media rendering.

- `blueprint.js` validates and converts the storyboard into a constrained 60-second film plan.
- `renderer.js` assembles ten six-second visual plates into one vertical MP4 using FFmpeg.
- Every shot must provide a narrator audio file. Missing narration blocks rendering.
- Optional music is mixed beneath narration with sidechain ducking.
- Optional per-shot sound effects can be supplied as scene assets.
- Scene title and caption overlays are burned into the video.

## Renderer contract

```js
const { renderFilm } = require("./renderer");

await renderFilm({
  blueprint,
  sceneAssets: [
    // exactly ten entries:
    // { videoPath: "/path/shot-01.mp4", narrationPath: "/path/voice-01.wav",
    //   soundEffectPath: "/path/optional-sfx.wav" }
  ],
  musicPath: "/path/optional-music.mp3",
  outputPath: "/path/final-film.mp4"
});
```

The renderer is deterministic and does not execute model-generated code. It expects media assets to be supplied by the upstream generation pipeline. It currently burns scene-level captions. Accurate word-by-word highlighting still requires a timestamped speech-alignment stage and is not claimed as complete.


## Automated output quality gate

After assembly, YTAgent performs a full FFmpeg decode pass and verifies that the MP4 contains both video and audio streams and is approximately 60 seconds long. A file that fails decoding, is missing audio/video, or has an unexpected duration is rejected instead of being marked successful. Render jobs are serialized within each server process to avoid overlapping FFmpeg workloads. This adds no service, package, or API cost. The check validates media integrity, not factual accuracy or visual storytelling quality.
