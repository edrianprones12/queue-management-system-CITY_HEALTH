"""Voice service readiness checks without using speakers or the SAPI engine."""

import threading
import unittest
from unittest.mock import patch

import pyttsx3_tts_service as tts


class VoiceReadinessTests(unittest.TestCase):
    def make_state(self):
        return tts.TtsState(rate=165, volume=1, dedupe_seconds=3600)

    @patch.object(tts, "pyttsx3", object())
    def test_busy_engine_reset_does_not_queue_warmup_behind_speech(self):
        state = self.make_state()
        state.speaking_key = "synthetic-active-speech"
        self.assertIsNone(state.engine)
        result = state.health(init_engine=True)
        self.assertTrue(result["ready"])
        self.assertTrue(result["speaking"])
        self.assertEqual(state.queue.qsize(), 0)

    @patch.object(tts, "pyttsx3", object())
    def test_pending_speech_is_ready_before_worker_initializes_engine(self):
        state = self.make_state()
        state.pending.add("synthetic-pending-speech")
        result = state.health(init_engine=True)
        self.assertTrue(result["ready"])
        self.assertEqual(state.queue.qsize(), 0)

    @patch.object(tts, "pyttsx3", object())
    def test_idle_startup_still_waits_for_worker_initialization(self):
        state = self.make_state()

        def initialize():
            warmup = state.queue.get(timeout=1)
            self.assertTrue(warmup["warm_up"])
            warmup["result"]["success"] = True
            warmup["done_event"].set()
            state.queue.task_done()

        worker = threading.Thread(target=initialize)
        worker.start()
        result = state.warm_up(timeout_seconds=1)
        worker.join(timeout=1)
        self.assertTrue(result["success"])
        self.assertFalse(worker.is_alive())


if __name__ == "__main__":
    unittest.main()
