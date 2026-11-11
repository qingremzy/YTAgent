const test = require("node:test");
const assert = require("node:assert/strict");
const { validateStoryboard, countNarrationWords } = require("../video-generator");

function makeStoryboard() {
  return {
    title: "A sample science story",
    scenes: Array.from({ length: 10 }, (_, index) => ({
      title: "Scene " + (index + 1),
      narration: "This is a distinct spoken line with enough words for timing " + (index + 1) + ".",
      caption: "A short caption",
      visual_direction: "A clear visual action unfolds in a cinematic environment."
    }))
  };
}

test("counts spoken words safely", () => {
  assert.equal(countNarrationWords("A small test with five spoken words."), 7);
});

test("accepts ten distinct narration lines within the scene speech budget", () => {
  const storyboard = validateStoryboard(makeStoryboard());
  assert.equal(storyboard.scenes.length, 10);
});

test("rejects narration that is too short for the intended spoken line", () => {
  const storyboard = makeStoryboard();
  storyboard.scenes[0].narration = "Too short.";
  assert.throws(() => validateStoryboard(storyboard), /Use 8 to 16 words/);
});

test("rejects narration that is too long for a six-second scene", () => {
  const storyboard = makeStoryboard();
  storyboard.scenes[0].narration = Array(17).fill("word").join(" ");
  assert.throws(() => validateStoryboard(storyboard), /Use 8 to 16 words/);
});

test("rejects repeated narration across scenes", () => {
  const storyboard = makeStoryboard();
  storyboard.scenes[1].narration = storyboard.scenes[0].narration;
  assert.throws(() => validateStoryboard(storyboard), /repeats narration/);
});
