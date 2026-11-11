/**
 * YTAgent Video Compiler — blueprint layer.
 *
 * The AI director describes a film in constrained data. It never supplies
 * executable JavaScript, Python, shell commands, or raw renderer expressions.
 * A renderer can safely translate this blueprint into a complete MP4.
 */

const TOTAL_DURATION_SECONDS = 60;
const SCENE_COUNT = 10;
const SCENE_DURATION_SECONDS = TOTAL_DURATION_SECONDS / SCENE_COUNT;

const CAMERA_MOVES = new Set([
  "push_in", "pull_out", "orbit_left", "orbit_right",
  "pan_left", "pan_right", "tilt_up", "tilt_down",
  "track_forward", "track_backward", "locked"
]);

const LIGHTING_PRESETS = new Set([
  "cinematic_soft", "dramatic_rim", "volumetric", "high_key",
  "low_key", "neon", "warm_natural", "cool_scientific"
]);

const ENVIRONMENT_TYPES = new Set([
  "studio", "space", "underwater", "microscopic", "human_body",
  "nature", "city", "laboratory", "abstract"
]);

const ACTION_TYPES = new Set([
  "reveal", "rotate", "move_forward", "move_backward", "expand",
  "contract", "pulse", "flow", "orbit", "split", "assemble",
  "transform", "collide", "rise", "fall", "glow", "particles",
  "camera_reveal", "demonstrate"
]);

function text(value, field, max = 220) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Video blueprint: " + field + " is required.");
  }
  const result = value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  if (result.length > max) throw new Error("Video blueprint: " + field + " exceeds " + max + " characters.");
  return result;
}

function enumValue(value, allowed, field, fallback) {
  const candidate = typeof value === "string" ? value : fallback;
  if (!allowed.has(candidate)) {
    throw new Error("Video blueprint: unsupported " + field + " '" + candidate + "'.");
  }
  return candidate;
}

/**
 * Convert a validated AI storyboard into renderer-neutral scene instructions.
 * Ten six-second shots form one continuous sixty-second film timeline.
 */
function compileBlueprint(storyboard, options = {}) {
  if (!storyboard || typeof storyboard !== "object" || Array.isArray(storyboard)) {
    throw new Error("Video blueprint: storyboard must be an object.");
  }
  if (!Array.isArray(storyboard.scenes) || storyboard.scenes.length !== SCENE_COUNT) {
    throw new Error("Video blueprint: exactly " + SCENE_COUNT + " scenes are required.");
  }

  const topic = text(options.topic || storyboard.title || "Untitled story", "topic", 180);
  const scenes = storyboard.scenes.map((scene, index) => {
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
      throw new Error("Video blueprint: scene " + (index + 1) + " must be an object.");
    }

    const direction = text(scene.visual_direction, "scene " + (index + 1) + " visual_direction", 500);
    const narration = text(scene.narration, "scene " + (index + 1) + " narration", 260);
    const caption = text(scene.caption || scene.title || narration, "scene " + (index + 1) + " caption", 120);

    // AI output is mapped to a small, safe vocabulary. Unknown values receive
    // sensible defaults rather than being interpreted as executable code.
    const action = ACTION_TYPES.has(scene.action) ? scene.action : "demonstrate";
    const environment = ENVIRONMENT_TYPES.has(scene.environment) ? scene.environment : "abstract";
    const camera = CAMERA_MOVES.has(scene.camera) ? scene.camera : "push_in";
    const lighting = LIGHTING_PRESETS.has(scene.lighting) ? scene.lighting : "cinematic_soft";

    return Object.freeze({
      id: "shot-" + String(index + 1).padStart(2, "0"),
      index,
      start_seconds: index * SCENE_DURATION_SECONDS,
      duration_seconds: SCENE_DURATION_SECONDS,
      end_seconds: (index + 1) * SCENE_DURATION_SECONDS,
      title: text(scene.title || "The next discovery", "scene " + (index + 1) + " title", 90),
      narration,
      caption,
      visual_direction: direction,
      world: Object.freeze({
        environment,
        subject: text(scene.subject || direction, "scene " + (index + 1) + " subject", 240),
        action,
        camera,
        lighting,
        atmosphere: typeof scene.atmosphere === "string"
          ? scene.atmosphere.replace(/[<>]/g, "").slice(0, 120)
          : "cinematic depth"
      }),
      transition_in: index === 0 ? "opening_reveal" : "match_motion",
      transition_out: index === SCENE_COUNT - 1 ? "final_hold" : "continuous_motion"
    });
  });

  return Object.freeze({
    format: "ytagent.video-blueprint.v1",
    title: text(storyboard.title || topic, "title", 100),
    topic,
    aspect_ratio: "9:16",
    width: 720,
    height: 1280,
    frame_rate: 30,
    duration_seconds: TOTAL_DURATION_SECONDS,
    scene_count: SCENE_COUNT,
    timeline: "single_continuous_film",
    scenes: Object.freeze(scenes)
  });
}

module.exports = {
  compileBlueprint,
  TOTAL_DURATION_SECONDS,
  SCENE_COUNT,
  SCENE_DURATION_SECONDS,
  CAMERA_MOVES,
  LIGHTING_PRESETS,
  ENVIRONMENT_TYPES,
  ACTION_TYPES
};
