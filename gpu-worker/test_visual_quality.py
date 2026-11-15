"""Regression tests for the GPU worker's OpenCV scene preflight."""
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

from visual_quality import inspect_video_quality


class VisualQualityTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)

    def write_video(self, name, frames):
        path = Path(self.temp_dir.name) / name
        writer = cv2.VideoWriter(
            str(path), cv2.VideoWriter_fourcc(*"MJPG"), 8.0, (96, 96)
        )
        if not writer.isOpened():
            self.skipTest("OpenCV MJPG encoder is unavailable in this runtime.")
        for frame in frames:
            writer.write(frame)
        writer.release()
        return path

    def test_rejects_unreadable_video(self):
        path = Path(self.temp_dir.name) / "missing.mp4"
        with self.assertRaisesRegex(RuntimeError, "could not open"):
            inspect_video_quality(path)

    def test_rejects_nearly_all_black_video(self):
        frames = [np.zeros((96, 96, 3), dtype=np.uint8) for _ in range(16)]
        path = self.write_video("black.avi", frames)
        with self.assertRaisesRegex(RuntimeError, "almost entirely black"):
            inspect_video_quality(path)

    def test_accepts_bright_moving_video(self):
        frames = []
        for index in range(16):
            frame = np.full((96, 96, 3), 80, dtype=np.uint8)
            left = 4 + index * 4
            cv2.rectangle(frame, (left, 25), (left + 20, 65), (240, 240, 240), -1)
            frames.append(frame)
        path = self.write_video("moving.avi", frames)
        report = inspect_video_quality(path)
        self.assertTrue(report["passed"])
        self.assertEqual(report["width"], 96)
        self.assertEqual(report["height"], 96)
        self.assertEqual(report["sampled_frames"], 7)
        self.assertFalse(report["motion_warning"])

    def test_flags_bright_static_video_without_rejecting_it(self):
        frame = np.full((96, 96, 3), 120, dtype=np.uint8)
        path = self.write_video("static.avi", [frame.copy() for _ in range(16)])
        report = inspect_video_quality(path)
        self.assertTrue(report["passed"])
        self.assertTrue(report["motion_warning"])


if __name__ == "__main__":
    unittest.main()
