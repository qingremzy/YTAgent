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
assert.equal(blueprint.scenes[5].end_seconds, 60);
assert.equal(blueprint.scenes[0].duration_seconds, 10);
assert.equal(blueprint.scenes[3].world.camera, "orbit_left");
assert.equal(blueprint.timeline, "single_continuous_film");
assert.equal(blueprint.audio.narrator.required, true);
assert.equal(blueprint.audio.narrator.fail_if_unavailable, true);
assert.equal(blueprint.audio.captions.synchronization, "scene_level_from_storyboard");
assert.equal(blueprint.audio.music.duck_under_narration, true);
assert.equal(blueprint.scenes[0].narration_segment.caption_sync, "scene_level");
assert.equal(blueprint.audio.music.required, false);
assert.equal(blueprint.audio.sound_effects.enabled, false);
assert.equal(blueprint.audio.mix.target_loudness_lufs, null);

assert.throws(() => compileBlueprint({ scenes: [] }), /exactly 6 ten-second scenes/);
assert.throws(() => compileBlueprint({
  scenes: Array.from({ length: SCENE_COUNT }, () => ({
    visual_direction: "A scene"
  }))
}), /narration is required/);

console.log("Video compiler blueprint tests passed.");

const shortBlueprint = compileBlueprint({
  title: "Short film",
  scenes: Array.from({ length: 3 }, (_, index) => ({
    title: "Beat " + index,
    narration: "A short narration for this scene.",
    caption: "A scene",
    visual_direction: "A character walks through a softly lit room and opens a mysterious door."
  }))
}, { durationSeconds: 30 });
assert.equal(shortBlueprint.duration_seconds, 30);
assert.equal(shortBlueprint.scene_count, 3);
assert.equal(shortBlueprint.scenes[2].end_seconds, 30);
const longSubjectStoryboard = {
  title: "Bounded scene subject",
  scenes: Array.from({ length: 3 }, () => ({
    title: "Beat",
    narration: "A short narration for this scene.",
    caption: "A scene",
    visual_direction: "A character walks through a softly lit room and opens a mysterious door.",
    subject: "A".repeat(500)
  }))
};
const boundedSubject = compileBlueprint(longSubjectStoryboard, { durationSeconds: 30 });
assert.equal(boundedSubject.scenes[0].world.subject.length, 240);
assert.throws(() => compileBlueprint(storyboard, { durationSeconds: 35 }), /30–600 seconds/);
