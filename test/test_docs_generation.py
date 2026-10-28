import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
STEPS = yaml.load((ROOT / '.github/blocks/update-docs/action.yaml').read_text(), Loader=yaml.BaseLoader)['runs']['steps']


class DocsGenerationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='docs-generation-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.docs = self.root / 'repo'
        self.docs.mkdir()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.output = self.root / 'outputs'
        self.log = self.root / 'pnpm-log'
        self.env = os.environ | {
            'PATH': f'{self.bin}:{os.environ["PATH"]}',
            'DOCS_DIR': str(self.docs), 'GITHUB_OUTPUT': str(self.output),
            'SERVICE_NAME': 'voice-ts', 'VERSION': '1.2.3',
            'DOCS_REPO': 'photon-hq/docs', 'DOCS_PATH': 'voice-ts',
            'CONTEXT_DIR': str(self.docs / '.update-docs-context'),
            'PNPM_LOG': str(self.log),
        }
        pnpm = self.bin / 'pnpm'
        pnpm.write_text(f'#!{sys.executable}\n' + '''import json
import os
import sys
with open(os.environ['PNPM_LOG'], 'a') as log:
    log.write(json.dumps({'args': sys.argv[1:], 'cwd': os.getcwd()}) + '\\n')
''')
        pnpm.chmod(0o755)

    def execute(self, name):
        script = next(step['run'] for step in STEPS if step.get('name') == name)
        return subprocess.run(['bash', '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script],
                              env=self.env, text=True, capture_output=True)

    def test_prompt_uses_existing_rules_without_requiring_a_voice_mapping(self):
        result = self.execute('Write Claude prompt')
        self.assertEqual(result.returncode, 0, result.stderr)
        prompt = (self.root / 'claude-prompt.txt').read_text()
        self.assertIn('AI updates to authored guides are allowed', prompt)
        self.assertIn('Read AGENTS.md, applicable directory instructions', prompt)
        self.assertIn('not a directory allowlist. If it is missing', prompt)
        self.assertIn('choose or create authored pages using existing conventions', prompt)
        self.assertIn('A missing reference producer does not prevent an authored guide update', prompt)
        self.assertIn('.references/sources.json', prompt)
        self.assertIn('preserve producer-owned files and navigation', prompt)
        self.assertIn('pnpm test, pnpm docs:validate, and pnpm docs:links', prompt)
        self.assertNotIn('pnpm update', prompt)
        self.assertNotIn('pnpm lint', prompt)
        self.assertNotIn('typecheck:docs', prompt)
        self.assertFalse((self.docs / 'voice-ts').exists())

    def test_dependency_install_preserves_the_lockfile(self):
        result = self.execute('Install docs dependencies')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.log.read_text()), {'args': ['install', '--frozen-lockfile'], 'cwd': str(self.docs)})


if __name__ == '__main__':
    unittest.main()
