const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFallbackArtwork } = require("./free-visual-fallback");

test("builds a vertical animated-fallback artwork for each scene", () => {
  const svg = buildFallbackArtwork({
    title: "Inside the human brain",
    visual_direction: "Neurons send electrical signals across the brain"
  }, 2, 10);
  assert.match(svg, /width="720" height="1280"/);
  assert.match(svg, /Inside the human brain/);
  assert.match(svg, /Neurons send electrical signals/);
  assert.match(svg, /VISUAL BACKUP • 3\/10/);
});

test("escapes unsafe text in fallback artwork", () => {
  const svg = buildFallbackArtwork({
    title: "<script>alert(1)</script>",
    visual_direction: "Cells & signals"
  }, 0, 10);
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /Cells &amp; signals/);
});

test("uses the monochrome graphite palette without blue or purple accents", () => {
  const svg = buildFallbackArtwork({
    title: "A monochrome scene",
    visual_direction: "A silver particle cloud moves through a dark chamber"
  }, 0, 10);
  assert.match(svg, /#08090b/);
  assert.match(svg, /#d7dbe0/);
  assert.doesNotMatch(svg, /hsl\(/i);
  assert.doesNotMatch(svg, /#67e8f9|#071426|#102b48/i);
});
