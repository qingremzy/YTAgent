const assert = require("node:assert/strict");
const { renderFilm } = require("./renderer");

const blueprint = {
  format: "ytagent.video-blueprint.v1",
  duration_seconds: 60,
  scenes: Array.from({ length: 10 }, (_, index) => ({
    title: "Shot " + index,
    caption: "A sample caption",
    narration: "A required spoken line."
  }))
};

async function main() {
  await assert.rejects(
    renderFilm({ blueprint, sceneAssets: Array.from({ length: 10 }, () => ({ videoPath: "/missing.mp4" })), outputPath: "/tmp/never.mp4" }),
    /no narrator audio/
  );
  await assert.rejects(
    renderFilm({ blueprint: { ...blueprint, duration_seconds: 30 }, sceneAssets: [], outputPath: "/tmp/never.mp4" }),
    /60-second/
  );
  console.log("Video renderer validation tests passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
