const assert = require("node:assert/strict");
const {
  compileBlueprint,
  TOTAL_DURATION_SECONDS,
  SCENE_COUNT
} = require("./blueprint");

const storyboard = {
  title: "Inside the human brain",
  scenes: Array.from({ length: SCENE_COUNT }, (_, index) => ({
    title: "Discovery " + (index + 1),
    narration: "A short narration for this scene.",
    caption: "Look closer",
    visual_direction: "A glowing neural pathway sends a pulse across the scene.",
    subject: "A network of neurons",
    environment: "microscopic",
    action: "flow",
    camera: "orbit_left",
    lighting: "volumetric"
  }))
};

const blueprint = compileBlueprint(storyboard, { topic: "The human brain" });

assert.equal(blueprint.format, "ytagent.video-blueprint.v1");
assert.equal(blueprint.duration_seconds, TOTAL_DURATION_SECONDS);
assert.equal(blueprint.scenes.length, SCENE_COUNT);
assert.equal(blueprint.scenes[0].start_seconds, 0);
assert.equal(blueprint.scenes[9].end_seconds, 60);
assert.equal(blueprint.scenes[3].world.camera, "orbit_left");
assert.equal(blueprint.timeline, "single_continuous_film");

assert.throws(() => compileBlueprint({ scenes: [] }), /exactly 10 scenes/);
assert.throws(() => compileBlueprint({
  scenes: Array.from({ length: SCENE_COUNT }, () => ({
    visual_direction: "A scene"
  }))
}), /narration is required/);

console.log("Video compiler blueprint tests passed.");
