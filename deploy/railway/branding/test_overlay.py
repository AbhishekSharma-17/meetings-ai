"""Offline checks against our pinned checkout; no credentials or services required."""
import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SOURCE = ROOT / "vendor/vexa/core/meetings/modules/join/src"
spec = importlib.util.spec_from_file_location("branding_overlay", HERE / "apply.py")
overlay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overlay)


class BrandingOverlayTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="meetings-ai-branding-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "src"
        shutil.copytree(SOURCE, self.root)

    def test_expected_files_only_and_audio_untouched(self):
        before = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob("*.ts")}
        overlay.apply(self.root)
        changed = {str(p) for p, original in before.items() if original != (self.root / p).read_bytes()}
        self.assertEqual(changed, {"browser-args.ts", "googlemeet/join.ts", "msteams/join.ts", "zoom/join.ts", "jitsi/join.ts"})
        for relative in ("googlemeet/join.ts", "msteams/join.ts", "zoom/join.ts", "jitsi/join.ts"):
            original = before[Path(relative)].decode()
            patched = (self.root / relative).read_text()
            # All original microphone/audio/voice-agent lines remain byte-identical.
            lines = lambda text: [line for line in text.splitlines() if any(term in line.lower() for term in ("microphone", "voiceagent", "audio", "micbutton", "michandle"))]
            self.assertEqual(lines(original), lines(patched), relative)
        google = (self.root / "googlemeet/join.ts").read_text()
        self.assertEqual(google.count("await enableStaticImage("), 2, "both authenticated and anonymous Meet lobbies")
        self.assertIn('isStaticLogoEnabled() ? "false" : "true"', (self.root / "jitsi/join.ts").read_text())

    def test_upstream_source_drift_fails_build(self):
        path = self.root / "browser-args.ts"
        path.write_text(path.read_text().replace("getJoinBrowserArgs", "changedUpstream"))
        with self.assertRaisesRegex(RuntimeError, "expected 1 anchors, found 0"):
            overlay.apply(self.root)

    def test_applying_twice_fails_instead_of_silently_corrupting(self):
        overlay.apply(self.root)
        with self.assertRaises(RuntimeError):
            overlay.apply(self.root)


if __name__ == "__main__":
    unittest.main()
