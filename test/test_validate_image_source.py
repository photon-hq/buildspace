import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import yaml

from git_fixture import commit_fixture


ROOT = Path(__file__).resolve().parents[1]
ACTION = yaml.safe_load((ROOT / '.github/blocks/validate-image-source/action.yaml').read_text())
SCRIPT = next(step['run'] for step in ACTION['runs']['steps'] if step.get('id') == 'identity')


class ValidateImageSourceTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.output = self.root / 'output'
        gh = self.root / 'gh'
        gh.write_text(
            '#!/bin/sh\n'
            '[ "$#" -eq 5 ] && [ "$1 $2 $3 $4 $5" = "release view $EXPECTED_RELEASE --json isDraft,isPrerelease" ] || exit 1\n'
            'cat "$RELEASE_METADATA"\n'
        )
        gh.chmod(0o755)

    def git(self, *args):
        subprocess.run(['git', *args], cwd=self.repo, check=True, capture_output=True)

    def run_identity(self, ref, sha, *, namespace='account', expected_release=''):
        self.output.write_text('')
        result = subprocess.run(['bash', '-c', SCRIPT], cwd=self.repo, env={
            **os.environ,
            'PATH': f'{self.root}:{os.environ["PATH"]}',
            'GITHUB_REF': ref,
            'GITHUB_SHA': sha,
            'GITHUB_OUTPUT': str(self.output),
            'NAMESPACE': namespace,
            'EXPECTED_RELEASE': expected_release,
            'RELEASE_METADATA': str(self.root / 'release.json'),
        }, capture_output=True, text=True)
        return result, self.output.read_text()

    def test_main_needs_neither_history_nor_a_release(self):
        sha = 'a' * 40
        result, output = self.run_identity('refs/heads/main', sha)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output, f'tag=main-{sha}\n')

    def test_hotfix_requires_a_stable_release_on_the_exact_ancestor(self):
        self.git('init', '-q')
        baseline = commit_fixture(self.repo, 'baseline')
        head = commit_fixture(self.repo, 'hotfix')
        release = f'account-{baseline}'
        ref = f'refs/heads/hotfix/account/{baseline}'
        self.git('tag', release, baseline)
        metadata = self.root / 'release.json'

        def check(sha, error=''):
            result, output = self.run_identity(ref, sha, expected_release=release)
            if error:
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(error, result.stderr)
                self.assertEqual(output, '')
            else:
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(output, f'tag=hotfix-{baseline}-{sha}\n')

        check(head, 'is required')
        for draft, prerelease in ((True, False), (False, True), (False, False)):
            with self.subTest(draft=draft, prerelease=prerelease):
                metadata.write_text(json.dumps({'isDraft': draft, 'isPrerelease': prerelease}))
                check(head, 'is required' if draft or prerelease else '')

        self.git('checkout', '--orphan', 'unrelated')
        check(commit_fixture(self.repo, 'unrelated'), 'not descended')
        self.git('tag', '-f', release, head)
        check(head, 'does not identify')
        self.git('tag', '-d', release)
        check(head, 'does not identify')

    def test_malformed_namespace_and_ref_do_not_produce_a_tag(self):
        sha = 'a' * 40
        for namespace, ref, error in (
            ('account;touch', 'refs/heads/main', 'namespace'),
            ('account', 'refs/heads/hotfix/account/not-a-sha', 'hotfix ref'),
            ('account', f'refs/heads/hotfix/other/{sha}', 'hotfix ref'),
        ):
            with self.subTest(namespace=namespace, ref=ref):
                result, output = self.run_identity(ref, sha, namespace=namespace)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(error, result.stderr)
                self.assertEqual(output, '')


if __name__ == '__main__':
    unittest.main()
