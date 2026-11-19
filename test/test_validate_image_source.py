import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
ACTION = yaml.safe_load(
    (ROOT / '.github/blocks/validate-image-source/action.yaml').read_text(),
)
SCRIPT = next(step['run'] for step in ACTION['runs']['steps'] if step.get('id') == 'identity')


class ValidateImageSourceTests(unittest.TestCase):
    def run_identity(self, *, ref, sha, namespace='account', release='stable', tag_sha=None, ancestor=True):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bin_dir = root / 'bin'
            bin_dir.mkdir()
            output = root / 'output'
            output.write_text('')

            gh = bin_dir / 'gh'
            gh.write_text('#!/bin/sh\nprintf \'%s\\n\' "$RELEASE_JSON"\n')
            gh.chmod(gh.stat().st_mode | stat.S_IEXEC)
            jq = bin_dir / 'jq'
            jq.write_text('#!/bin/sh\ncat >/dev/null\n[ "$RELEASE_OK" = true ]\n')
            jq.chmod(jq.stat().st_mode | stat.S_IEXEC)
            git = bin_dir / 'git'
            git.write_text(
                '#!/bin/sh\n'
                'case "$1" in\n'
                '  rev-parse) printf \'%s\\n\' "$TAG_SHA" ;;\n'
                '  merge-base) [ "$ANCESTOR_OK" = true ] ;;\n'
                '  *) exit 1 ;;\n'
                'esac\n',
            )
            git.chmod(git.stat().st_mode | stat.S_IEXEC)
            env = {
                **os.environ,
                'PATH': f'{bin_dir}:{os.environ["PATH"]}',
                'GITHUB_REF': ref,
                'GITHUB_SHA': sha,
                'GITHUB_OUTPUT': str(output),
                'NAMESPACE': namespace,
                'RELEASE_JSON': '{"isDraft":false,"isPrerelease":false}',
                'RELEASE_OK': str(release == 'stable').lower(),
                'TAG_SHA': tag_sha or sha,
                'ANCESTOR_OK': str(ancestor).lower(),
            }
            return subprocess.run(['bash', '-c', SCRIPT], env=env, capture_output=True, text=True), output.read_text()

    def test_main_uses_the_event_sha_without_release_or_history_reads(self):
        sha = 'a' * 40
        result, output = self.run_identity(ref='refs/heads/main', sha=sha)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output, f'tag=main-{sha}\n')

    def test_hotfix_requires_stable_release_exact_tag_and_ancestry(self):
        baseline = 'b' * 40
        sha = 'c' * 40
        ref = f'refs/heads/hotfix/account/{baseline}'
        result, output = self.run_identity(ref=ref, sha=sha, tag_sha=baseline)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output, f'tag=hotfix-{baseline}-{sha}\n')

        for kwargs, message in (
            ({'release': 'missing', 'tag_sha': baseline}, 'stable release'),
            ({'tag_sha': 'd' * 40}, 'stable release'),
            ({'ancestor': False, 'tag_sha': baseline}, 'descended'),
        ):
            with self.subTest(message=message):
                failed, _ = self.run_identity(ref=ref, sha=sha, **kwargs)
                self.assertNotEqual(failed.returncode, 0)
                self.assertIn(message, failed.stderr)

    def test_namespace_and_hotfix_baseline_use_a_strict_grammar(self):
        sha = 'a' * 40
        failed, _ = self.run_identity(ref='refs/heads/main', sha=sha, namespace='account;touch')
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn('namespace', failed.stderr)

        failed, _ = self.run_identity(ref='refs/heads/hotfix/account/not-a-sha', sha=sha)
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn('hotfix ref', failed.stderr)


if __name__ == '__main__':
    unittest.main()
