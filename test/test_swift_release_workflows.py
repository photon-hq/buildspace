"""Check the Swift stage/promote workflows' trust boundaries and build step."""
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest

import yaml

STAGE = yaml.load(Path('.github/workflows/swift-stage.yml').read_text(), Loader=yaml.BaseLoader)
PROMOTE = yaml.load(Path('.github/workflows/swift-promote.yml').read_text(), Loader=yaml.BaseLoader)
CALLER_CODE = ('swift build', 'pkgbuild', 'SECRET_ENV_VARS', 'APP_PRIVATE_KEY', 'setup-swift')


def step(job, name):
    return next(s for s in job['steps'] if s.get('name') == name)


class WorkflowTests(unittest.TestCase):
    def test_actions_are_pinned_and_inputs_never_reach_a_shell_directly(self):
        for workflow in (STAGE, PROMOTE):
            for job in workflow['jobs'].values():
                if 'uses' in job:
                    self.assertRegex(job['uses'], r'@[a-f0-9]{40}$')
                for s in job.get('steps', []):
                    if 'uses' in s:
                        self.assertRegex(s['uses'], r'@[a-f0-9]{40}$')
                    self.assertNotIn('${{', s.get('run', ''))

    def test_the_version_is_computed_read_only_under_v_tags(self):
        version = STAGE['jobs']['version']
        self.assertEqual(version['permissions'], {'contents': 'read', 'pull-requests': 'read'})
        checkout = next(s for s in version['steps'] if s.get('uses', '').startswith('actions/checkout@'))
        self.assertEqual(checkout['with']['fetch-depth'], '0')
        self.assertIn('version --production-tag-prefix v --paths "$PATHS"', step(version, 'Compute the release version')['run'])
        build = STAGE['jobs']['build']
        self.assertEqual(build['needs'], 'version')
        self.assertEqual(step(build, 'Build the staging package and its production candidate')['env']['RELEASE_VERSION'], '${{ needs.version.outputs.version }}')
        for job, name in ((build, 'Collect'), (STAGE['jobs']['publish'], 'Publish the staging build and attach its candidate')):
            self.assertEqual(step(job, name)['env']['BUMP'], '${{ needs.version.outputs.bump }}', name)
            self.assertIn('--bump "$BUMP"', step(job, name)['run'], name)

    def test_caller_code_and_its_secrets_stay_in_the_read_only_build_job(self):
        build = STAGE['jobs']['build']
        self.assertEqual(build['permissions'], {'contents': 'read', 'actions': 'read'})
        self.assertEqual(build['runs-on'], "${{ inputs.library && 'ubuntu-24.04' || 'macos-26' }}")
        for workflow in (STAGE, PROMOTE):
            for name, job in workflow['jobs'].items():
                if workflow is STAGE and name == 'build':
                    continue
                for marker in CALLER_CODE:
                    self.assertNotIn(marker, yaml.dump(job), f'{name}: {marker}')
        holders = [s.get('name') for s in build['steps'] if 'secrets.SECRET_ENV_VARS' in yaml.dump(s)]
        self.assertEqual(holders, ['Build the staging package and its production candidate'])

    def test_staging_publication_requires_main_and_attests_before_publishing(self):
        publish = STAGE['jobs']['publish']
        self.assertEqual(publish['needs'], ['version', 'build'])
        self.assertEqual(publish['if'], "github.ref == 'refs/heads/main' && !inputs.dry-run")
        self.assertEqual(publish['permissions'], {'contents': 'write', 'attestations': 'write', 'id-token': 'write'})
        names = [s.get('name') for s in publish['steps']]
        attest = step(publish, 'Attest the staging package and its production candidate')
        self.assertLess(names.index(attest['name']), names.index('Publish the staging build and attach its candidate'))
        self.assertEqual(attest['if'], '${{ !inputs.library }}')
        self.assertEqual(publish['concurrency']['cancel-in-progress'], 'false')

    def test_promotion_resolves_read_only_and_releases_behind_the_environment(self):
        resolve = PROMOTE['jobs']['resolve']
        self.assertEqual(resolve['if'], "github.ref == 'refs/heads/main'")
        self.assertFalse(any(level == 'write' for level in resolve['permissions'].values()))
        self.assertEqual(step(resolve, 'Resolve and verify the candidate')['env']['SIGNER_WORKFLOW'], '${{ job.workflow_repository }}/.github/workflows/swift-stage.yml')
        upload = next(s for s in resolve['steps'] if 'upload-artifact' in s.get('uses', ''))
        self.assertEqual(upload['if'], "steps.resolve.outputs.pending == 'true'")
        publish = PROMOTE['jobs']['publish']
        self.assertEqual(publish['needs'], 'resolve')
        self.assertEqual(publish['if'], "needs.resolve.outputs.pending == 'true'")
        self.assertEqual(publish['environment'], '${{ inputs.environment }}')
        self.assertEqual(PROMOTE['on']['workflow_call']['inputs']['environment']['default'], 'production')
        self.assertIn('--channel production', step(publish, 'Release the candidate')['run'])
        self.assertNotEqual(STAGE['jobs']['publish']['concurrency']['group'], publish['concurrency']['group'])

    def test_jamf_receives_only_the_released_package_of_an_approved_promotion(self):
        jamf = PROMOTE['jobs']['jamf-upload']
        self.assertEqual(jamf['needs'], ['resolve', 'publish'])
        self.assertEqual(jamf['if'], "inputs.jamf-url != '' && !inputs.library")
        self.assertTrue(jamf['uses'].startswith('photon-hq/jamf-package-updater/.github/workflows/jamf-upload.yml@'))
        self.assertEqual(jamf['with']['artifact_name'], 'swift-promotion')


def executable(path, body):
    path.write_text('#!/bin/sh\n' + body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


class BuildStepTests(unittest.TestCase):
    """Runs the build step with stand-ins for swift, codesign and pkgbuild."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'repository'
        self.bin = Path(self.tmp.name) / 'bin'
        self.root.mkdir()
        self.bin.mkdir()
        git = ['git', '-C', str(self.root), '-c', 'user.name=Test', '-c', 'user.email=test@example.com']
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root / '.gitignore').write_text('.env\n.build/\n')
        (self.root / 'Package.swift').write_text('// swift-tools-version: 6.2\n')
        subprocess.run([*git, 'add', '.'], check=True)
        subprocess.run([*git, 'commit', '-qm', 'source'], check=True)
        # swift build records the .env it compiled with, as BetterEnv bakes it in.
        executable(self.bin / 'swift', 'mkdir -p .build/release\ncp .env ".build/release/$PACKAGE_NAME"\ncat .env >> "$RUNNER_TEMP/compiled"\n')
        executable(self.bin / 'codesign', 'echo "$@" >> "$RUNNER_TEMP/signed"\n')
        executable(self.bin / 'pkgbuild', 'for out; do :; done\nprintf "%s\\n" "$@" > "$out"\ncp -R "$2" "$out.root"\n')
        self.script = step(STAGE['jobs']['build'], 'Build the staging package and its production candidate')['run']

    def build(self, **overrides):
        env = {
            **os.environ,
            'PATH': f'{self.bin}:{os.environ["PATH"]}',
            'RUNNER_TEMP': str(Path(self.tmp.name) / 'temp'),
            'PACKAGE_NAME': 'macrocosm-astrolabe',
            'IDENTIFIER': 'codes.photon.macrocosm-astrolabe',
            'SCRIPTS_PATH': '',
            'PAYLOAD_PATH': '',
            'RESOURCE_BUNDLES': '',
            'ENTITLEMENTS': '',
            'RELEASE_VERSION': '1.27.0',
            'STAGING_SUFFIX': '-staging.9.1',
            'SECRET_ENV_VARS': 'TAILSCALE_AUTH=secret',
            'DEPENDENCY_TOKEN': '',
            **overrides,
        }
        Path(env['RUNNER_TEMP']).mkdir(exist_ok=True)
        return subprocess.run(['bash', '-c', self.script], cwd=self.root, env=env, capture_output=True, text=True)

    def test_each_channel_is_compiled_and_packaged_at_its_own_version(self):
        result = self.build(ENTITLEMENTS='ent.plist')
        self.assertEqual(result.returncode, 0, result.stderr)
        temp = Path(self.tmp.name) / 'temp'
        self.assertEqual((temp / 'compiled').read_text(), ''.join(
            f'VERSION={version}\nBUILD_ENVIRONMENT=production\nRELEASE_CHANNEL={channel}\nTAILSCALE_AUTH=secret\n'
            for channel, version in (('staging', '1.27.0-staging.9.1'), ('production', '1.27.0'))
        ))
        for channel, version in (('staging', '1.27.0-staging.9.1'), ('production', '1.27.0')):
            package = temp / 'pack' / channel / 'macrocosm-astrolabe.pkg'
            args = package.read_text().splitlines()
            self.assertEqual(args[args.index('--version') + 1], version)
            self.assertEqual(args[args.index('--identifier') + 1], 'codes.photon.macrocosm-astrolabe')
            self.assertNotIn('--scripts', args)
            binary = Path(str(package) + '.root') / 'usr/local/bin/macrocosm-astrolabe'
            self.assertIn(f'VERSION={version}', binary.read_text())
        self.assertEqual((temp / 'signed').read_text().count('--entitlements ent.plist'), 2)
        self.assertFalse((self.root / '.env').exists())

    def test_a_package_needs_a_valid_name_and_an_identifier(self):
        self.assertIn('Invalid package name', self.build(PACKAGE_NAME='../escape').stderr)
        self.assertIn('needs an identifier', self.build(IDENTIFIER='').stderr)

    def test_a_build_that_changes_tracked_files_fails(self):
        executable(self.bin / 'swift', 'mkdir -p .build/release\ntouch ".build/release/$PACKAGE_NAME"\necho changed > Package.swift\n')
        result = self.build()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('changed tracked files', result.stderr)


if __name__ == '__main__':
    unittest.main()
