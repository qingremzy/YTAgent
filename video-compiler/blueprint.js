/**
 * YTAgent Video Compiler — blueprint layer.
 *
 * AI supplies constrained film instructions, never executable code.
 * The renderer must produce one complete film and a mandatory narrator track.
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

    return Object.freeze({
      id: "shot-" + String(index + 1).padStart(2, "0"),
      index,
      start_seconds: index * SCENE_DURATION_SECONDS,
      duration_seconds: SCENE_DURATION_SECONDS,
      end_seconds: (index + 1) * SCENE_DURATION_SECONDS,
      title: text(scene.title || "The next discovery", "scene " + (index + 1) + " title", 90),
      narration,
      narration_segment: Object.freeze({
        required: true,
        text: narration,
        timeline_start_seconds: index * SCENE_DURATION_SECONDS,
        timeline_end_seconds: (index + 1) * SCENE_DURATION_SECONDS,
        caption_sync: "scene_level"
      }),
      caption,
      visual_direction: direction,
      world: Object.freeze({
        environment: ENVIRONMENT_TYPES.has(scene.environment) ? scene.environment : "abstract",
        subject: text(scene.subject || direction, "scene " + (index + 1) + " subject", 240),
        action: ACTION_TYPES.has(scene.action) ? scene.action : "demonstrate",
        camera: CAMERA_MOVES.has(scene.camera) ? scene.camera : "push_in",
        lighting: LIGHTING_PRESETS.has(scene.lighting) ? scene.lighting : "cinematic_soft",
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
    audio: Object.freeze({
      narrator: Object.freeze({
        required: true,
        style: "natural_cinematic_documentary",
        language: options.language || "en",
        voice_id: options.voiceId || "en-US-AriaNeural",
        delivery: "expressive_clear_storytelling",
        fail_if_unavailable: true
      }),
      captions: Object.freeze({
        required: true,
        synchronization: "scene_level_from_storyboard",
        burn_into_video: true
      }),
      music: Object.freeze({
        required: false,
        style: "optional_cinematic",
        duck_under_narration: true
      }),
      sound_effects: Object.freeze({
        enabled: false,
        synchronized_to_scene_actions: false
      }),
      mix: Object.freeze({
        narrator_priority: "foreground",
        prevent_clipping: true,
        target_loudness_lufs: null,
        true_peak_db: -1
      })
    }),
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
