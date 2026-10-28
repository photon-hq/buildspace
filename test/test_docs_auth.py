import base64
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import yaml
from git_fixture import commit_fixture


ROOT = Path(__file__).resolve().parents[1]
ACTION = yaml.load((ROOT / '.github/blocks/update-docs/action.yaml').read_text(), Loader=yaml.BaseLoader)
CLONE = next(step for step in ACTION['runs']['steps'] if step.get('id') == 'clone-docs')['run']
CLEANUP = next(step for step in ACTION['runs']['steps'] if step.get('name') == 'Cleanup')['run']


class DocsAuthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='docs-auth-real-git-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.git('init', '-q', '-b', 'main')
        (self.source / 'README.md').write_text('fixture docs\n')
        self.git('add', '.')
        commit_fixture(self.source, 'fixture docs source')
        self.runner = self.root / 'runner'
        self.runner.mkdir()
        self.workspace = self.root / 'workspace'
        (self.workspace / 'docs-repo').mkdir(parents=True)
        (self.workspace / 'docs-repo/keep').write_text('not owned by the action')
        self.output = self.root / 'outputs'
        self.output.touch()
        self.config = self.root / 'fixture.gitconfig'
        self.config.write_text(f'[url "{self.source}"]\n\tinsteadOf = https://github.com/fixture/docs.git\n')
        self.token = 'SYNTHETIC_TEST_SENTINEL'
        self.env = os.environ | {'RUNNER_TEMP': str(self.runner), 'GITHUB_WORKSPACE': str(self.workspace),
                                'GITHUB_OUTPUT': str(self.output), 'GIT_CONFIG_GLOBAL': str(self.config),
                                'GH_TOKEN': self.token, 'DOCS_REPO': 'fixture/docs', 'DOCS_BRANCH': 'main'}

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.source), *args], text=True, capture_output=True, check=True)

    def execute(self, script, **env):
        return subprocess.run(['bash', '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script],
                              env=self.env | env, text=True, capture_output=True)

    def clone_outputs(self):
        return dict(line.split('=', 1) for line in self.output.read_text().splitlines())

    def test_real_clone_does_not_store_or_print_authentication(self):
        result = self.execute(CLONE)
        self.assertEqual(result.returncode, 0, result.stderr)
        values = self.clone_outputs()
        config = (Path(values['docs-dir']) / '.git/config').read_text()
        captured = result.stdout + result.stderr + self.output.read_text() + config
        for secret in (self.token, base64.b64encode(f'x-access-token:{self.token}'.encode()).decode()):
            self.assertNotIn(secret, captured)
        self.assertNotIn('extraheader', config)
        self.assertNotIn('x-access-token', config)
        self.assertEqual((Path(values['docs-dir']) / 'README.md').read_text(), 'fixture docs\n')
        self.assertTrue((self.workspace / 'docs-repo/keep').exists())

    def test_real_failed_clone_removes_only_the_allocated_directory(self):
        result = self.execute(CLONE, DOCS_BRANCH='nonexistent')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(Path(self.clone_outputs()['cleanup-root']).exists())
        self.assertTrue((self.workspace / 'docs-repo/keep').exists())
        captured = result.stdout + result.stderr + self.output.read_text()
        for secret in (self.token, base64.b64encode(f'x-access-token:{self.token}'.encode()).decode()):
            self.assertNotIn(secret, captured)

    def test_failed_output_write_removes_the_allocated_directory(self):
        result = self.execute(CLONE, GITHUB_OUTPUT=str(self.root))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list(self.runner.iterdir()), [])
        self.assertTrue((self.workspace / 'docs-repo/keep').exists())

    def test_always_cleanup_removes_generation_files_and_clone(self):
        result = self.execute(CLONE)
        self.assertEqual(result.returncode, 0, result.stderr)
        owned = Path(self.clone_outputs()['cleanup-root'])
        (owned / 'claude-prompt.txt').write_text('fixture prompt')
        (owned / 'pr-body.md').write_text('fixture body')
        self.assertEqual(self.execute(CLEANUP, DOCS_TEMP=str(owned)).returncode, 0)
        self.assertFalse(owned.exists())
        self.assertTrue((self.workspace / 'docs-repo/keep').exists())

    def test_cleanup_refuses_empty_foreign_and_traversal_paths(self):
        for value in ('', str(self.workspace), str(self.runner / 'buildspace-docs.fake/../outside')):
            self.assertEqual(self.execute(CLEANUP, DOCS_TEMP=value).returncode, 0)
            self.assertTrue((self.workspace / 'docs-repo/keep').exists())

    def test_public_outputs_and_generation_contract_are_retained(self):
        self.assertEqual(set(ACTION['outputs']), {'pr-url', 'has-changes'})
        create = next(step for step in ACTION['runs']['steps'] if step.get('id') == 'create-pr')['run']
        self.assertNotIn('remote set-url', create)
        self.assertIn('GIT_CONFIG_VALUE_1=', create)
        self.assertNotIn("--jq '.[0].url // empty')\" || true", create)
        self.assertEqual(next(step for step in ACTION['runs']['steps'] if step.get('name') == 'Cleanup')['if'], 'always()')


if __name__ == '__main__':
    unittest.main()
