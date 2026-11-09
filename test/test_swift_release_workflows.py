"""Check the Swift stage/promote workflows' trust boundaries and build step."""
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import unittest

import yaml

STAGE = yaml.load(Path('.github/workflows/swift-stage.yml').read_text(), Loader=yaml.BaseLoader)
PROMOTE = yaml.load(Path('.github/workflows/swift-promote.yml').read_text(), Loader=yaml.BaseLoader)
PACKAGE = yaml.load(Path('.github/blocks/swift-stage-package/action.yml').read_text(), Loader=yaml.BaseLoader)
CALLER_CODE = ('swift build', 'pkgbuild', 'swift-stage-package', 'SECRET_ENV_VARS', 'APP_PRIVATE_KEY', 'setup-swift')
BUILDS = ('Build the staging package', 'Build the production candidate')
# The start of a swift stand-in: records its arguments and answers --show-bin-path.
SWIFT = 'echo "$@" >> "$RUNNER_TEMP/swift-args"\ncase "$*" in *--show-bin-path) echo .build/release; exit;; esac\n'


def step(job, name):
    return next(s for s in job['steps'] if s.get('name') == name)


class WorkflowTests(unittest.TestCase):
    def test_actions_are_pinned_and_inputs_never_reach_a_shell_directly(self):
        for workflow in (STAGE, PROMOTE):
            for job in workflow['jobs'].values():
                if 'uses' in job:
                    self.assertRegex(job['uses'], r'@[a-f0-9]{40}$')
                for s in [*job.get('steps', []), *PACKAGE['runs']['steps']]:
                    if 'uses' in s and not s['uses'].startswith('$/'):
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
        for name in BUILDS:
            self.assertTrue(step(build, name)['with']['version'].startswith('${{ needs.version.outputs.version }}'), name)
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
                if workflow is PROMOTE and name == 'resolve':
                    job = {**job, 'steps': [s for s in job['steps'] if s.get('name') != 'Mint a token to read private dependencies']}
                for marker in CALLER_CODE:
                    self.assertNotIn(marker, yaml.dump(job), f'{name}: {marker}')
        token = step(build, 'Mint a token for private dependencies')
        self.assertEqual({k: v for k, v in token['with'].items() if k.startswith('permission-')}, {'permission-contents': 'read'})
        holders = [s.get('name') for s in build['steps'] if 'secrets.SECRET_ENV_VARS' in yaml.dump(s)]
        self.assertEqual(holders, list(BUILDS))

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
        self.assertNotIn('if', resolve)
        self.assertEqual(resolve['steps'][0]['name'], 'Require a dispatch from main')
        self.assertIn('"$GITHUB_REF" != refs/heads/main', resolve['steps'][0]['run'])
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

    def test_promotion_measures_staging_age_read_only(self):
        resolve = PROMOTE['jobs']['resolve']
        self.assertEqual(resolve['permissions'], {'contents': 'read', 'actions': 'read', 'attestations': 'read', 'pull-requests': 'read'})
        # Publishing checks again, reading labels, when a release came out after resolution.
        self.assertEqual(PROMOTE['jobs']['publish']['permissions'], {'contents': 'write', 'pull-requests': 'read'})
        inputs = PROMOTE['on']['workflow_call']['inputs']
        self.assertEqual(inputs['minimum-staging-age']['default'], '2h')
        self.assertEqual(inputs['skip-minimum-age-reason']['default'], '')
        resolving = step(resolve, 'Resolve and verify the candidate')
        self.assertEqual(resolving['env']['MINIMUM_AGE'], '${{ inputs.minimum-staging-age }}')
        self.assertEqual(resolving['env']['SKIP_MINIMUM_AGE_REASON'], '${{ inputs.skip-minimum-age-reason }}')
        # Joined with =, so a reason that starts with - is a value, not an option.
        self.assertIn('--minimum-age="$MINIMUM_AGE" --skip-minimum-age-reason="$SKIP_MINIMUM_AGE_REASON"', resolving['run'])
        for name, job in PROMOTE['jobs'].items():
            if name != 'resolve':
                self.assertNotIn('skip-minimum-age-reason', yaml.dump(job), name)

    def test_promotion_reads_private_dependencies_with_a_read_only_token(self):
        resolve = PROMOTE['jobs']['resolve']
        token = step(resolve, 'Mint a token to read private dependencies')
        self.assertEqual(token['if'], 'inputs.private-deps')
        self.assertEqual({k: v for k, v in token['with'].items() if k.startswith('permission-')}, {'permission-contents': 'read'})
        holders = [s.get('name') for s in resolve['steps'] if 'steps.dependency-token.outputs.token' in yaml.dump(s)]
        self.assertEqual(holders, ['Resolve and verify the candidate'])
        self.assertEqual(step(resolve, 'Resolve and verify the candidate')['env']['DEPENDENCY_TOKEN'], '${{ steps.dependency-token.outputs.token }}')
        for name, job in PROMOTE['jobs'].items():
            if name != 'resolve':
                self.assertNotIn('APP_PRIVATE_KEY', yaml.dump(job), name)

    def test_jamf_receives_only_the_released_package_of_an_approved_promotion(self):
        jamf = PROMOTE['jobs']['jamf-upload']
        self.assertEqual(jamf['needs'], ['resolve', 'publish'])
        self.assertEqual(jamf['if'], "inputs.jamf-url != '' && !inputs.library")
        self.assertTrue(jamf['uses'].startswith('photon-hq/jamf-package-updater/.github/workflows/jamf-upload.yml@'))
        self.assertEqual(jamf['with']['artifact_name'], 'swift-promotion')
        self.assertEqual(jamf['with']['tool_ref'], jamf['uses'].rsplit('@', 1)[1])


def executable(path, body):
    path.write_text('#!/bin/sh\n' + body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


class BuildStepTests(unittest.TestCase):
    """Runs the build job's package steps, and the actions they use, with stand-ins for swift, codesign and pkgbuild."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'repository'
        self.bin = Path(self.tmp.name) / 'bin'
        self.temp = Path(self.tmp.name) / 'temp'
        for directory in (self.root, self.bin, self.temp):
            directory.mkdir()
        git = ['git', '-C', str(self.root), '-c', 'user.name=Test', '-c', 'user.email=test@example.com']
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root / '.gitignore').write_text('.env\n.build/\n')
        (self.root / 'Package.swift').write_text('// swift-tools-version: 6.2\n')
        subprocess.run([*git, 'add', '.'], check=True)
        subprocess.run([*git, 'commit', '-qm', 'source'], check=True)
        # swift build records the .env it compiled with, as BetterEnv bakes it in.
        executable(self.bin / 'swift', SWIFT + 'mkdir -p .build/release/Tool_Tool.bundle\ncp .env .build/release/macrocosm-astrolabe\ncat .env >> "$RUNNER_TEMP/compiled"\n')
        executable(self.bin / 'codesign', 'echo "$@" >> "$RUNNER_TEMP/signed"\n')
        executable(self.bin / 'pkgbuild', 'for out; do :; done\nprintf "%s\\n" "$@" > "$out"\ncp -R "$2" "$out.root"\n')
        self.env = {**os.environ, 'PATH': f'{self.bin}:{os.environ["PATH"]}', 'RUNNER_TEMP': str(self.temp), 'GITHUB_OUTPUT': str(self.temp / 'outputs')}

    def run_steps(self, steps, context):
        """Runs steps as a runner would, returning the first failure; evaluates only the conditions these steps use.
        As on a runner, a skipped step's outputs are empty."""
        lookup = lambda name: context.get(name, '') if name.startswith('steps.') else context[name]
        expand = lambda text: re.sub(r'\$\{\{ ([\w.-]+) \}\}', lambda match: lookup(match[1]), text)
        for s in steps:
            negated = re.fullmatch(r'\$\{\{ !([\w.-]+) \}\}', s.get('if', ''))
            compared = re.fullmatch(r"([\w.-]+) != '(.*)'", s.get('if', ''))
            self.assertTrue('if' not in s or negated or compared, s.get('if'))
            if (negated and context[negated[1]] == 'true') or (compared and context[compared[1]] == compared[2]):
                continue
            env = {**self.env, **{name: expand(value) for name, value in s.get('env', {}).items()}}
            given = {name: expand(value) for name, value in s.get('with', {}).items()}
            action = Path.cwd() / s.get('uses', '$/').removeprefix('$/')
            definition = yaml.load(next(action.glob('action.y*ml')).read_text(), Loader=yaml.BaseLoader) if 'uses' in s else None
            if 'run' in s:
                result = subprocess.run(['bash', '-eo', 'pipefail', '-c', s['run']], cwd=self.root, env=env, capture_output=True, text=True)
            elif definition['runs']['using'] == 'composite':
                inputs = {f'inputs.{name}': given.get(name, field.get('default', '')) for name, field in definition['inputs'].items()}
                result = self.run_steps(definition['runs']['steps'], {'runner.temp': context['runner.temp'], **inputs})
            else:
                outputs = Path(tempfile.mkstemp(dir=self.temp)[1])
                env.update({f'INPUT_{name.upper()}': value for name, value in given.items()}, GITHUB_OUTPUT=str(outputs))
                result = subprocess.run(['node', str(action / definition['runs']['main'])], cwd=self.root, env=env, capture_output=True, text=True)
                for name, _, value in re.findall(r'^([\w-]+)<<(\S+)\n(.*?)\n\2$', outputs.read_text(), re.M | re.S):
                    context[f'steps.{s.get("id")}.outputs.{name}'] = value
            if result and result.returncode:
                return result
        return None

    def build(self, **inputs):
        steps = STAGE['jobs']['build']['steps']
        names = [s.get('name') for s in steps]
        context = {
            **{f'inputs.{name}': field.get('default', '') for name, field in STAGE['on']['workflow_call']['inputs'].items()},
            'inputs.package-name': 'macrocosm-astrolabe',
            'inputs.identifier': 'codes.photon.macrocosm-astrolabe',
            **{f'inputs.{name.replace("_", "-")}': value for name, value in inputs.items()},
            'needs.version.outputs.version': '1.27.0',
            'github.run_id': '9',
            'github.run_attempt': '1',
            'secrets.SECRET_ENV_VARS': 'TAILSCALE_AUTH=secret',
            'steps.dependency-token.outputs.token': '',
            'runner.temp': str(self.temp),
        }
        return self.run_steps(steps[names.index('Check the package and its source'):names.index('Require the builds to leave tracked files unchanged') + 1], context)

    def test_each_channel_is_compiled_and_packaged_at_its_own_version(self):
        (self.root / 'payload/Library/LaunchDaemons').mkdir(parents=True)
        (self.root / 'payload/Library/LaunchDaemons/codes.photon.example.plist').write_text('plist')
        failure = self.build(entitlements='ent.plist', payload_path='payload', resource_bundles='Tool_Tool.bundle', scripts_path='scripts')
        self.assertIsNone(failure, failure and failure.stderr)
        self.assertEqual((self.temp / 'compiled').read_text(), ''.join(
            f'VERSION={version}\nBUILD_ENVIRONMENT=production\nRELEASE_CHANNEL={channel}\nTAILSCALE_AUTH=secret\n'
            for channel, version in (('staging', '1.27.0-staging.9.1'), ('production', '1.27.0'))
        ))
        for channel, version in (('staging', '1.27.0-staging.9.1'), ('production', '1.27.0')):
            package = self.temp / 'pack' / channel / 'macrocosm-astrolabe.pkg'
            self.assertEqual(package.read_text().splitlines(), [
                '--root', str(self.temp / 'pkgroot' / channel), '--identifier', 'codes.photon.macrocosm-astrolabe',
                '--install-location', '/', '--version', version, '--scripts', 'scripts', str(package),
            ])
            root = Path(str(package) + '.root')
            self.assertEqual(sorted(str(p.relative_to(root)) for p in root.rglob('*')), [
                'Library', 'Library/LaunchDaemons', 'Library/LaunchDaemons/codes.photon.example.plist',
                'usr', 'usr/local', 'usr/local/bin', 'usr/local/bin/Tool_Tool.bundle', 'usr/local/bin/macrocosm-astrolabe',
            ])
            self.assertIn(f'VERSION={version}', (root / 'usr/local/bin/macrocosm-astrolabe').read_text())
        self.assertEqual((self.temp / 'swift-args').read_text().splitlines(), ['build -c release', 'build -c release --show-bin-path'] * 2)
        self.assertEqual(len(re.findall(r'^-s - --entitlements ent\.plist -f /.+/\.build/release/macrocosm-astrolabe$', (self.temp / 'signed').read_text(), re.M)), 2)
        self.assertFalse((self.root / '.env').exists())

    def test_a_package_needs_a_valid_name_and_an_identifier(self):
        self.assertIn('Invalid package name', self.build(package_name='../escape').stderr)
        self.assertIn('needs an identifier', self.build(identifier='').stderr)

    def test_a_build_that_changes_tracked_files_fails(self):
        executable(self.bin / 'swift', SWIFT + 'mkdir -p .build/release\ntouch .build/release/macrocosm-astrolabe\necho changed > Package.swift\n')
        failure = self.build()
        self.assertIsNotNone(failure)
        self.assertIn('changed tracked files', failure.stderr)


class ToolchainStepTests(unittest.TestCase):
    """Runs the steps around setup-swift against a package that pins its toolchain."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'repository'
        self.root.mkdir()
        self.git = ['git', '-C', str(self.root), '-c', 'user.name=Test', '-c', 'user.email=test@example.com']
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root / 'Package.swift').write_text('// swift-tools-version: 6.2\n')
        self.build = STAGE['jobs']['build']

    def run_step(self, name):
        outputs = Path(self.tmp.name) / 'outputs'
        outputs.write_text('')
        env = {**os.environ, 'GITHUB_OUTPUT': str(outputs)}
        result = subprocess.run(['bash', '-c', step(self.build, name)['run']], cwd=self.root, env=env, capture_output=True, text=True)
        return result, outputs.read_text()

    def commit(self, swift_version=None):
        if swift_version is not None:
            (self.root / '.swift-version').write_text(swift_version)
        subprocess.run([*self.git, 'add', '.'], check=True)
        subprocess.run([*self.git, 'commit', '-qm', 'source'], check=True)

    def test_setup_swift_installs_the_pinned_version_or_the_latest(self):
        setup = next(s for s in self.build['steps'] if s.get('uses', '').startswith('swift-actions/setup-swift@'))
        self.assertEqual(setup['with']['swift-version'], '${{ steps.swift-version.outputs.value }}')
        names = [s.get('name', s.get('uses')) for s in self.build['steps']]
        read, keep = 'Read the Swift version the package pins', 'Keep the committed .swift-version'
        self.assertEqual(step(self.build, read)['id'], 'swift-version')
        self.assertLess(names.index(read), names.index(setup['uses']))
        self.assertLess(names.index(setup['uses']), names.index(keep))
        self.assertLess(names.index(keep), names.index(BUILDS[0]))
        self.commit()
        self.assertEqual(self.run_step(read)[1], 'value=latest\n')
        self.commit('6.3.3\n')
        self.assertEqual(self.run_step(read)[1], 'value=6.3.3\n')

    def test_a_swift_version_that_is_not_a_toolchain_name_fails(self):
        self.commit('6.3.3 $(id)\n')
        result, outputs = self.run_step('Read the Swift version the package pins')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('does not name a Swift toolchain', result.stderr)
        self.assertEqual(outputs, '')

    def test_the_committed_swift_version_survives_the_toolchain_setup(self):
        keep = 'Keep the committed .swift-version'
        self.commit()
        result, _ = self.run_step(keep)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / '.swift-version').exists())
        self.commit('6.3.3\n')
        (self.root / '.swift-version').write_text('6.4.1')
        result, _ = self.run_step(keep)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / '.swift-version').read_text(), '6.3.3\n')


class CollectStepTests(unittest.TestCase):
    """Runs the collect step's command line against the real release tools."""

    def collect(self, library):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        temp = Path(tmp.name)
        for channel in ('staging', 'production'):
            (temp / 'pack' / channel).mkdir(parents=True)
            (temp / 'pack' / channel / 'macrocosm-astrolabe.pkg').write_text(f'xar {channel}')
        bump = {'version': '1.27.0', 'from': 'v1.26.0', 'level': 'minor', 'total': 1, 'changes': [{'number': 91, 'title': 'feat: one', 'level': 'minor'}], 'warnings': []}
        env = {
            **os.environ,
            'RUNNER_TEMP': tmp.name,
            'RELEASE_TOOLS': str(Path('.github/package-release').resolve()),
            'PACKAGE_NAME': 'macrocosm-astrolabe',
            'LIBRARY': 'true' if library else 'false',
            'BUMP': json.dumps(bump),
            'STAGING_SUFFIX': '-staging.9.1',
            'GITHUB_SHA': 'a' * 40,
            'GITHUB_REPOSITORY': 'photon-hq/macrocosm-astrolabe',
            'GITHUB_SERVER_URL': 'https://github.com',
            'GITHUB_RUN_ID': '9',
            'GITHUB_RUN_ATTEMPT': '1',
            'GITHUB_OUTPUT': str(temp / 'outputs'),
        }
        script = step(STAGE['jobs']['build'], 'Collect')['run']
        result = subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads((temp / 'swift-release' / 'release-manifest.json').read_text())

    def test_a_package_build_is_collected_under_its_staging_tag(self):
        manifest = self.collect(library=False)
        self.assertEqual(manifest['stagingTag'], 'v1.27.0-staging.9.1')
        self.assertEqual(manifest['pkg']['staging']['version'], '1.27.0-staging.9.1')

    def test_a_library_build_is_collected_under_its_staging_tag(self):
        manifest = self.collect(library=True)
        self.assertEqual(manifest['stagingTag'], 'v1.27.0-staging.9.1')
        self.assertIsNone(manifest['pkg'])


if __name__ == '__main__':
    unittest.main()
