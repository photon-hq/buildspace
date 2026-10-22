"""Release-note generation needs read-only analysis, not host privilege changes."""
from pathlib import Path
import unittest

import yaml

RELEASE_INFO = yaml.load(
    Path('.github/blocks/generate-release-info/action.yaml').read_text(),
    Loader=yaml.BaseLoader,
)
SELF_RELEASE = yaml.load(
    Path('.github/workflows/self-release.yaml').read_text(),
    Loader=yaml.BaseLoader,
)
NOTE_STEPS = (
    ('shared', next(s for s in RELEASE_INFO['runs']['steps'] if s.get('id') == 'ai-notes'),
     '${{ inputs.openai-api-key }}'),
    ('self-release', next(s for s in SELF_RELEASE['jobs']['release-info']['steps'] if s.get('id') == 'notes'),
     '${{ secrets.OPENAI_API_KEY }}'),
)


class ReleaseNotesTests(unittest.TestCase):
    def test_notes_explicitly_use_the_read_only_safety_strategy(self):
        for name, step, _key in NOTE_STEPS:
            with self.subTest(action=name):
                self.assertTrue(step['uses'].startswith('openai/codex-action@'))
                # sandbox: read-only alone still defaults to host-wide drop-sudo.
                self.assertEqual(step['with'].get('safety-strategy'), 'read-only')

    def test_each_notes_invocation_receives_its_api_key(self):
        for name, step, key in NOTE_STEPS:
            with self.subTest(action=name):
                self.assertEqual(step['with'].get('openai-api-key'), key)

    def test_notes_still_flow_through_the_existing_public_outputs(self):
        self.assertEqual(RELEASE_INFO['outputs']['release_notes']['value'],
                         '${{ steps.ai-notes.outputs.final-message }}')
        self.assertEqual(SELF_RELEASE['jobs']['release-info']['outputs']['release_notes'],
                         '${{ steps.notes.outputs.final-message }}')
