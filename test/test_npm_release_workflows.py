"""Check the npm stage/promote workflows' trust boundaries and pack step."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

import yaml

STAGE = yaml.load(Path('.github/workflows/npm-stage.yml').read_text(), Loader=yaml.BaseLoader)
PROMOTE = yaml.load(Path('.github/workflows/npm-promote.yml').read_text(), Loader=yaml.BaseLoader)
CALLER_SCRIPTS = re.compile(r'inputs\.(pack|verify|install)\b')


def step(job, name):
    return next(s for s in job['steps'] if s.get('name') == name)


class WorkflowTests(unittest.TestCase):
    def test_actions_are_pinned_and_inputs_never_reach_a_shell_directly(self):
        for workflow in (STAGE, PROMOTE):
            for job in workflow['jobs'].values():
                for s in job['steps']:
                    if 'uses' in s:
                        self.assertRegex(s['uses'], r'@[a-f0-9]{40}$')
                    self.assertNotIn('${{', s.get('run', ''))

    def test_caller_code_runs_only_in_the_read_only_build_job(self):
        build = STAGE['jobs']['build']
        self.assertEqual(build['permissions'], {'contents': 'read', 'packages': 'read', 'actions': 'read'})
        self.assertEqual(build['if'], "github.ref == 'refs/heads/main' || inputs.dry-run")
        for name, job in STAGE['jobs'].items():
            if name != 'build':
                self.assertIsNone(CALLER_SCRIPTS.search(yaml.dump(job)), name)

    def test_staging_publication_requires_main_and_attests_before_publishing(self):
        publish = STAGE['jobs']['publish']
        self.assertEqual(publish['if'], "github.ref == 'refs/heads/main' && !inputs.dry-run")
        self.assertEqual(publish['needs'], 'build')
        names = [s.get('name') for s in publish['steps']]
        self.assertLess(names.index('Attest every packed file'), names.index('Publish the staging build and attach its candidates'))
        self.assertEqual(publish['concurrency']['cancel-in-progress'], 'false')

    def test_promotion_resolves_read_only_and_publishes_behind_the_environment(self):
        resolve = PROMOTE['jobs']['resolve']
        self.assertEqual(resolve['if'], "github.ref == 'refs/heads/main'")
        self.assertFalse(any(level == 'write' for level in resolve['permissions'].values()))
        publish = PROMOTE['jobs']['publish']
        self.assertEqual(publish['needs'], 'resolve')
        self.assertEqual(publish['environment'], '${{ inputs.environment }}')
        self.assertEqual(PROMOTE['on']['workflow_call']['inputs']['environment']['default'], 'production')
        self.assertIn('--channel production', step(publish, 'Publish the candidates under latest')['run'])
        signer = step(resolve, 'Resolve and verify the candidates')['env']['SIGNER_WORKFLOW']
        self.assertEqual(signer, '${{ job.workflow_repository }}/.github/workflows/npm-stage.yml')
        self.assertNotEqual(STAGE['jobs']['publish']['concurrency']['group'], publish['concurrency']['group'])


class PackStepTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        git = ['git', '-C', str(self.root), '-c', 'user.name=Test', '-c', 'user.email=test@example.com']
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root / 'package.json').write_text('{"version":"1.2.3"}\n')
        subprocess.run([*git, 'add', '.'], check=True)
        subprocess.run([*git, 'commit', '-qm', 'source'], check=True)
        self.script = step(STAGE['jobs']['build'], 'Pack the staging build and its production candidate')['run']

    def pack(self, command):
        env = dict(os.environ, RUNNER_TEMP=str(self.root / 'temp'), PACK=command, STAGING_SUFFIX='-staging.9.1')
        return subprocess.run(['bash', '-c', self.script], cwd=self.root, env=env, capture_output=True, text=True)

    def test_each_channel_gets_its_destination_and_suffix(self):
        result = self.pack('echo "$RELEASE_CHANNEL[$RELEASE_SUFFIX]" > "$PACK_DESTINATION/seen"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / 'temp/pack/staging/seen').read_text(), 'staging[-staging.9.1]\n')
        self.assertEqual((self.root / 'temp/pack/production/seen').read_text(), 'production[]\n')

    def test_a_pack_that_leaves_tracked_changes_fails(self):
        result = self.pack('echo changed > package.json')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('changed tracked files', result.stderr)
        self.assertFalse((self.root / 'temp/pack/production').exists())

    def test_packing_requires_a_clean_checkout(self):
        (self.root / 'package.json').write_text('{"version":"9.9.9"}\n')
        self.assertNotEqual(self.pack('true').returncode, 0)


if __name__ == '__main__':
    unittest.main()
