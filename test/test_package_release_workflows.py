"""Check the package stage/promote workflows' trust boundaries and pack step."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import unittest

import yaml

STAGE = yaml.load(Path('.github/workflows/package-stage.yml').read_text(), Loader=yaml.BaseLoader)
PROMOTE = yaml.load(Path('.github/workflows/package-promote.yml').read_text(), Loader=yaml.BaseLoader)
CALLER_SCRIPTS = re.compile(r'inputs\.(pack|verify|install)\b|cargo ')
# GitHub states who dispatched the run and who started this attempt; no input
# can claim either, and a re-run by or of someone else's run is not trusted.
TRUSTED_DISPATCH = "github.event_name == 'workflow_dispatch' && inputs.trusted-actor != '' && github.actor == inputs.trusted-actor && github.triggering_actor == inputs.trusted-actor"


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

    def test_the_install_token_reaches_only_the_install_script(self):
        self.assertEqual(STAGE['on']['workflow_call']['secrets']['INSTALL_TOKEN']['required'], 'false')
        holders = [
            (name, s.get('name'))
            for name, job in STAGE['jobs'].items()
            for s in job['steps']
            if 'secrets.INSTALL_TOKEN' in yaml.dump(s)
        ]
        self.assertEqual(holders, [('build', 'Install')])
        self.assertNotIn('secrets.INSTALL_TOKEN', yaml.dump({k: v for k, v in STAGE['jobs']['build'].items() if k != 'steps'}))
        self.assertNotIn('INSTALL_TOKEN', yaml.dump(PROMOTE))

    def test_promotion_carries_its_candidates_under_the_callers_artifact_name(self):
        self.assertEqual(PROMOTE['on']['workflow_call']['inputs']['artifact-name']['default'], 'package-promotion')
        named = [
            (name, s['uses'].split('@')[0].split('/')[-1])
            for name, job in PROMOTE['jobs'].items()
            for s in job['steps']
            if s.get('with', {}).get('name') == '${{ inputs.artifact-name }}'
        ]
        self.assertEqual(named, [('resolve', 'upload-artifact'), ('publish', 'download-artifact')])

    def test_the_publish_job_receives_the_build_under_the_callers_artifact_name(self):
        self.assertEqual(STAGE['on']['workflow_call']['inputs']['artifact-name']['default'], 'package-release')
        named = [
            (name, s['uses'].split('@')[0].split('/')[-1])
            for name, job in STAGE['jobs'].items()
            for s in job['steps']
            if s.get('with', {}).get('name') == '${{ inputs.artifact-name }}'
        ]
        self.assertEqual(named, [('build', 'upload-artifact'), ('publish', 'download-artifact')])

    def test_staging_publication_requires_main_and_attests_before_publishing(self):
        publish = STAGE['jobs']['publish']
        self.assertEqual(publish['if'], "github.ref == 'refs/heads/main' && !inputs.dry-run")
        self.assertEqual(publish['needs'], 'build')
        names = [s.get('name') for s in publish['steps']]
        self.assertLess(names.index('Attest every packed file'), names.index('Publish the staging build and attach its candidates'))
        self.assertLess(names.index('Attest every packaged crate'), names.index('Publish the staging build and attach its candidates'))
        self.assertEqual(step(publish, 'Attest every packaged crate')['if'], "inputs.crates != ''")
        self.assertEqual(publish['concurrency']['cancel-in-progress'], 'false')

    def test_crates_are_packaged_after_verification_and_before_the_npm_packs(self):
        names = [s.get('name') for s in STAGE['jobs']['build']['steps']]
        self.assertLess(names.index('Verify'), names.index('Package the Rust crates'))
        self.assertLess(names.index('Package the Rust crates'), names.index('Pack the staging build and its production candidate'))
        self.assertIn('--crates="$CRATES"', step(STAGE['jobs']['publish'], 'Publish the staging build and attach its candidates')['run'])

    def test_promotion_resolves_read_only_and_publishes_behind_the_environment(self):
        resolve = PROMOTE['jobs']['resolve']
        self.assertEqual(resolve['if'], "github.ref == 'refs/heads/main'")
        self.assertFalse(any(level == 'write' for level in resolve['permissions'].values()))
        publish = PROMOTE['jobs']['publish']
        self.assertEqual(publish['needs'], 'resolve')
        self.assertEqual(publish['if'], "needs.resolve.outputs.pending == 'true'")
        self.assertEqual(publish['environment'], "${{ !(%s) && inputs.environment || '' }}" % TRUSTED_DISPATCH)
        self.assertEqual(PROMOTE['on']['workflow_call']['inputs']['environment']['default'], 'production')
        self.assertIn('--channel production', step(publish, 'Publish the candidates under latest')['run'])
        signer = step(resolve, 'Resolve and verify the candidates')['env']['SIGNER_WORKFLOW']
        self.assertEqual(signer, '${{ job.workflow_repository }}/.github/workflows/package-stage.yml')
        self.assertNotEqual(STAGE['jobs']['publish']['concurrency']['group'], publish['concurrency']['group'])


    def test_only_the_trusted_actors_own_dispatch_publishes_without_the_environment(self):
        inputs = PROMOTE['on']['workflow_call']['inputs']
        self.assertEqual(inputs['trusted-actor']['default'], '')
        resolve = step(PROMOTE['jobs']['resolve'], 'Resolve and verify the candidates')
        self.assertEqual(resolve['env']['APPROVED_BY'], "${{ %s && github.triggering_actor || '' }}" % TRUSTED_DISPATCH)
        self.assertIn('--approved-by "$APPROVED_BY"', resolve['run'])
        # Its declaration and the two expressions above: nothing else decides on it.
        self.assertEqual(yaml.dump(PROMOTE).count('trusted-actor'), 7)

    def test_an_image_tag_selects_the_build_and_a_released_build_stores_nothing(self):
        resolve = PROMOTE['jobs']['resolve']
        self.assertIn('--image-tag "$IMAGE_TAG"', step(resolve, 'Resolve and verify the candidates')['run'])
        upload = next(s for s in resolve['steps'] if 'upload-artifact' in s.get('uses', ''))
        self.assertEqual(upload['if'], "steps.resolve.outputs.pending == 'true'")
        self.assertEqual(PROMOTE['on']['workflow_call']['outputs']['pending']['value'], '${{ jobs.resolve.outputs.pending }}')


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


@unittest.skipUnless(shutil.which('cargo'), 'cargo is not installed')
class CrateStepTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.git = ['git', '-C', str(self.root), '-c', 'user.name=Test', '-c', 'user.email=test@example.com']
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root / 'src').mkdir()
        (self.root / 'src/lib.rs').write_text('pub fn adapter() {}\n')
        (self.root / 'Cargo.toml').write_text('[package]\nname = "adapter"\nversion = "0.4.0"\nedition = "2021"\npublish = false\n')
        (self.root / '.gitignore').write_text('/target\n')
        subprocess.run(['cargo', 'generate-lockfile', '--offline', '--quiet'], cwd=self.root, check=True)
        subprocess.run([*self.git, 'add', '.'], check=True)
        subprocess.run([*self.git, 'commit', '-qm', 'source'], check=True)
        self.script = step(STAGE['jobs']['build'], 'Package the Rust crates')['run']

    def package(self, crates):
        env = dict(os.environ, RUNNER_TEMP=str(self.root / 'temp'), CRATES=crates, CARGO_NET_OFFLINE='true')
        return subprocess.run(['bash', '-c', self.script], cwd=self.root, env=env, capture_output=True, text=True)

    def test_each_crate_is_packaged_from_the_checked_out_commit(self):
        result = self.package('adapter')
        self.assertEqual(result.returncode, 0, result.stderr)
        head = subprocess.run([*self.git, 'rev-parse', 'HEAD'], check=True, capture_output=True, text=True).stdout.strip()
        with tarfile.open(self.root / 'temp/pack/crates/adapter-0.4.0.crate') as crate:
            names = crate.getnames()
            vcs = crate.extractfile('adapter-0.4.0/.cargo_vcs_info.json').read().decode()
        self.assertIn(head, vcs)
        self.assertNotIn('adapter-0.4.0/Cargo.lock', names)

    def test_uncommitted_changes_and_invalid_names_fail(self):
        self.assertNotEqual(self.package('--allow-dirty').returncode, 0)
        (self.root / 'src/lib.rs').write_text('pub fn changed() {}\n')
        result = self.package('adapter')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('uncommitted', result.stderr)


if __name__ == '__main__':
    unittest.main()
