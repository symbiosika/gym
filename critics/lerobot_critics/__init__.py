"""lerobot-critics: decide which LeRobot episodes are good enough for training.

Two families of critics run over every episode of a dataset:

* **hard critics** -- deterministic checks on the parquet/video data (smoothness,
  duration, tracking error, duplicate frames, image quality, sensor limits, grasp
  cycles, integrity). Each has a weight and default thresholds.
* **soft critics** -- task-specific success indicators judged by a vision-language
  model (Gemini video understanding, or any OpenAI-compatible image model). Each
  indicator has a weight and a free-text description.

A normalized YAML/JSON *spec* describes the task, the objects, and which critics to
run with which weights. The runner produces per-episode scores, an accept/review/
reject verdict, and an include/exclude list that can be fed to training.
"""

from .spec.models import CriticSpec  # noqa: F401

__version__ = "0.1.0"
