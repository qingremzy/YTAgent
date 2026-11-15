"""Lightweight OpenCV preflight checks for generated scene videos.

This checks basic visual integrity before a scene is uploaded to Railway.
It deliberately avoids subjective blur/sharpness rejection because dark,
soft-focus and atmospheric shots can be intentional.
"""
from pathlib import Path


def inspect_video_quality(video_path, sample_count=7):
    try:
        import cv2
        import numpy as np
    except ImportError as exc:
        raise RuntimeError(
            "OpenCV visual preflight is unavailable. Install gpu-worker/requirements.txt."
        ) from exc

    path = str(Path(video_path))
    capture = cv2.VideoCapture(path)
    if not capture.isOpened():
        raise RuntimeError(f"OpenCV could not open generated scene: {path}")

    try:
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        if frame_count < 2 or fps <= 0 or width <= 0 or height <= 0:
            raise RuntimeError("Generated scene has invalid video dimensions or timing.")

        duration = frame_count / fps
        positions = sorted({
            min(frame_count - 1, max(0, round(i * (frame_count - 1) / max(1, sample_count - 1))))
            for i in range(sample_count)
        })
        luminance_means = []
        frame_signatures = []
        for frame_index in positions:
            capture.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
            ok, frame = capture.read()
            if not ok or frame is None:
                continue
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            luminance_means.append(float(np.mean(gray)))
            # Small thumbnail signature makes the motion check cheap and deterministic.
            thumbnail = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA)
            frame_signatures.append(thumbnail.astype(np.float32))

        if len(luminance_means) < max(2, sample_count // 2):
            raise RuntimeError("Generated scene could not be decoded at enough sample points.")

        near_black_count = sum(value < 4.0 for value in luminance_means)
        if near_black_count / len(luminance_means) >= 0.8:
            raise RuntimeError(
                "Generated scene appears almost entirely black "
                f"({near_black_count}/{len(luminance_means)} sampled frames)."
            )

        motion_deltas = []
        for previous, current in zip(frame_signatures, frame_signatures[1:]):
            motion_deltas.append(float(np.mean(np.abs(current - previous))))

        return {
            "passed": True,
            "width": width,
            "height": height,
            "duration_seconds": round(duration, 3),
            "sampled_frames": len(luminance_means),
            "mean_luminance": round(float(np.mean(luminance_means)), 2),
            "near_black_frames": near_black_count,
            "mean_sampled_frame_difference": round(
                float(np.mean(motion_deltas)) if motion_deltas else 0.0, 3
            ),
            "motion_warning": bool(motion_deltas) and max(motion_deltas) < 0.15,
        }
    finally:
        capture.release()
