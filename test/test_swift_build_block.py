"""Run the toolchain steps of blocks/swift-build, which Swift PR and release builds use."""
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest

import yaml

BLOCK = yaml.load(Path('.github/blocks/swift-build/action.yml').read_text(), Loader=yaml.BaseLoader)
STEPS = BLOCK['runs']['steps']
READ = 'Read the Swift version the package pins'
KEEP = 'Keep the committed .swift-version'


def step(name):
    return next(s for s in STEPS if s.get('name') == name)


def executable(path, body):
    path.write_text('#!/bin/sh\n' + body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


class ToolchainStepTests(unittest.TestCase):
    """Runs the steps around setup-swift against a stand-in swift and a package that may pin its toolchain."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'repository'
        self.root.mkdir()
        self.git = ['git', '-C', str(self.root), '-c', 'user.name=Test', '-c', 'user.email=test@example.com']
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root / 'Package.swift').write_text('// swift-tools-version: 6.2\n')
        self.bin = Path(self.tmp.name) / 'bin'
        self.bin.mkdir()
        executable(self.bin / 'swift', 'echo "swift-driver version: 1.148.6 Apple Swift version 6.3.3 (swiftlang-6.3.3.1.3 clang-2100.1.1.101)"\n')

    def run_step(self, name):
        outputs = Path(self.tmp.name) / 'outputs'
        outputs.write_text('')
        env = {**os.environ, 'GITHUB_OUTPUT': str(outputs), 'PATH': f"{self.bin}:{os.environ['PATH']}"}
        result = subprocess.run(['bash', '-c', step(name)['run']], cwd=self.root, env=env, capture_output=True, text=True)
        return result, outputs.read_text()

    def commit(self, swift_version=None):
        if swift_version is not None:
            (self.root / '.swift-version').write_text(swift_version)
        subprocess.run([*self.git, 'add', '.'], check=True)
        subprocess.run([*self.git, 'commit', '-qm', 'source'], check=True)

    def test_setup_swift_gets_the_read_version_and_runs_only_when_there_is_one(self):
        setup = next(s for s in STEPS if s.get('uses', '').startswith('swift-actions/setup-swift@'))
        self.assertEqual(step(READ)['id'], 'swift-version')
        self.assertEqual(setup['if'], "steps.swift-version.outputs.value != ''")
        self.assertEqual(setup['with']['swift-version'], '${{ steps.swift-version.outputs.value }}')
        self.assertEqual(step(KEEP)['if'], "steps.swift-version.outputs.value != ''")
        names = [s.get('name', s.get('uses')) for s in STEPS]
        self.assertLess(names.index(READ), names.index(setup['uses']))
        self.assertLess(names.index(setup['uses']), names.index(KEEP))
        self.assertLess(names.index(KEEP), names.index('Build Swift Binary'))

    def test_the_read_step_installs_the_latest_or_a_pin_the_runner_lacks(self):
        # No pin: the latest release, as before.
        self.commit()
        result, outputs = self.run_step(READ)
        self.assertEqual(outputs, 'value=latest\n')
        self.assertNotIn('::notice::', result.stdout)
        # A pin the runner image already provides: nothing to install, no notice.
        self.commit('6.3.3\n')
        result, outputs = self.run_step(READ)
        self.assertEqual(outputs, 'value=\n')
        self.assertNotIn('::notice::', result.stdout)
        # A pin the image lacks: that version, with a notice that names both versions.
        self.commit('6.4.2\n')
        result, outputs = self.run_step(READ)
        self.assertEqual(outputs, 'value=6.4.2\n')
        self.assertIn('::notice::.swift-version pins Swift 6.4.2. The runner image has Swift 6.3.3', result.stdout)
        # No Swift on the runner: the pin, or the latest without one; nothing to compare, so no notice.
        executable(self.bin / 'swift', 'exit 127\n')
        result, outputs = self.run_step(READ)
        self.assertEqual(outputs, 'value=6.4.2\n')
        self.assertNotIn('::notice::', result.stdout)
        (self.root / '.swift-version').unlink()
        self.assertEqual(self.run_step(READ)[1], 'value=latest\n')

    def test_a_swift_version_that_is_not_a_toolchain_name_fails(self):
        self.commit('6.3.3 $(id)\n')
        result, outputs = self.run_step(READ)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('does not name a Swift toolchain', result.stderr)
        self.assertEqual(outputs, '')

    def test_the_committed_swift_version_survives_the_toolchain_setup(self):
        self.commit()
        result, _ = self.run_step(KEEP)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / '.swift-version').exists())
        self.commit('6.3.3\n')
        (self.root / '.swift-version').write_text('6.4.1')
        result, _ = self.run_step(KEEP)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / '.swift-version').read_text(), '6.3.3\n')


if __name__ == '__main__':
    unittest.main()
