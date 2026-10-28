import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import yaml
from git_fixture import commit_fixture


ROOT = Path(__file__).resolve().parents[1]
ACTION = yaml.load((ROOT / '.github/blocks/collect-release-context/action.yaml').read_text(), Loader=yaml.BaseLoader)


def git(root, *args):
    return subprocess.run(['git', '-C', str(root), *args], text=True, capture_output=True, check=True).stdout.strip()


def outputs(path):
    lines = path.read_text().splitlines()
    result = {}
    index = 0
    while index < len(lines):
        line = lines[index]
        if '<<' in line:
            key, delimiter = line.split('<<', 1)
            end = lines.index(delimiter, index + 1)
            result[key] = '\n'.join(lines[index + 1:end])
            index = end + 1
        else:
            key, value = line.split('=', 1)
            result[key] = value
            index += 1
    return result


def execute(root, tag, notes='fixture release'):
    with tempfile.TemporaryDirectory(prefix='context-output-') as tmp:
        temp = Path(tmp)
        output = temp / 'outputs'
        output.touch()
        env = os.environ | {'RAW_TAG': tag, 'RELEASE_BODY': notes, 'RUNNER_TEMP': tmp, 'GITHUB_OUTPUT': str(output)}
        results = []
        for step in ACTION['runs']['steps']:
            result = subprocess.run(['bash', '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step['run']],
                                    cwd=root, env=env, text=True, capture_output=True)
            results.append(result)
            if result.returncode:
                break
        return results, outputs(output), [p.name for p in temp.glob('release-context.*')]


class ContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='real-git-context-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        git(self.root, 'init', '-q')
        (self.root / 'released.txt').write_text('released code\n')
        git(self.root, 'add', '.')
        commit_fixture(self.root, 'fixture released source')
        git(self.root, 'tag', 'v1.0.0')

    def test_first_release_uses_tag_not_newer_default_branch_head(self):
        (self.root / 'unreleased.txt').write_text('not part of this release\n')
        git(self.root, 'add', '.')
        commit_fixture(self.root, 'fixture newer default branch')
        results, values, leftovers = execute(self.root, 'v1.0.0')
        self.assertTrue(all(r.returncode == 0 for r in results))
        self.assertIn('released.txt', values['changes_diff'])
        self.assertNotIn('unreleased.txt', values['changes_diff'])
        self.assertEqual(values['version'], '1.0.0')
        self.assertEqual(values['release_tag'], 'v1.0.0')
        self.assertEqual(values['previous_tag'], '')
        self.assertEqual(leftovers, [])

    def test_previous_tag_path_matches_original_on_real_git(self):
        (self.root / 'released.txt').write_text('changed release\n')
        git(self.root, 'add', '.')
        commit_fixture(self.root, 'fixture next release')
        git(self.root, 'tag', 'v2.0.0')
        tags = git(self.root, 'tag', '--sort=-creatordate').splitlines()
        current, previous = tags[0], tags[1]
        (self.root / 'unreleased.txt').write_text('newer than the selected release\n')
        commit_fixture(self.root, 'fixture later default branch')
        git(self.root, 'tag', 'v3.0.0')
        (self.root / '.github').mkdir()
        (self.root / '.github/CODEOWNERS').write_text('* @reviewer-z @fixture/team\nREADME.md @reviewer-a\n')
        notes = 'release notes\nGHDELIM_literal\nEXPLANATION_EOF\nlast'
        results, values, _ = execute(self.root, current, notes)
        self.assertTrue(all(r.returncode == 0 for r in results))
        self.assertEqual(values['changes_diff'], git(self.root, 'diff', previous, current))
        self.assertNotIn('unreleased.txt', values['changes_diff'])
        self.assertEqual(values['previous_tag'], previous)
        self.assertEqual(values['release_notes'], notes)
        self.assertEqual(values['reviewers'], 'reviewer-a,reviewer-z')

    def test_missing_unknown_and_option_like_tag_fail(self):
        for tag in ('', 'v9.9.9', '--help'):
            results, values, leftovers = execute(self.root, tag)
            self.assertNotEqual(results[-1].returncode, 0)
            self.assertNotIn('changes_diff', values)
            self.assertEqual(leftovers, [])

    def test_no_owners_and_team_only_owners_remain_empty(self):
        self.assertEqual(execute(self.root, 'v1.0.0')[1]['reviewers'], '')
        (self.root / 'CODEOWNERS').write_text('*.md\n# No owners declared\n')
        results, values, _ = execute(self.root, 'v1.0.0')
        self.assertTrue(all(result.returncode == 0 for result in results))
        self.assertEqual(values['reviewers'], '')
        (self.root / 'CODEOWNERS').write_text('* @fixture/team\n')
        self.assertEqual(execute(self.root, 'v1.0.0')[1]['reviewers'], '')

    def test_large_real_diff_is_bounded_without_environment_transport(self):
        git(self.root, 'tag', '-d', 'v1.0.0')
        (self.root / 'large.txt').write_text('a' * 150000)
        git(self.root, 'add', '.')
        commit_fixture(self.root, 'fixture large release')
        git(self.root, 'tag', 'v3.0.0')
        results, values, leftovers = execute(self.root, 'v3.0.0')
        self.assertTrue(all(r.returncode == 0 for r in results))
        suffix = '\n\n... [diff truncated at 100000 characters]'
        self.assertTrue(values['changes_diff'].endswith(suffix))
        self.assertEqual(len(values['changes_diff']), 100000 + len(suffix))
        self.assertEqual(leftovers, [])

    def test_nul_in_real_text_diff_is_removed(self):
        git(self.root, 'tag', '-d', 'v1.0.0')
        (self.root / '.gitattributes').write_text('binary.txt diff\n')
        (self.root / 'binary.txt').write_bytes(b'a\x00b\n')
        git(self.root, 'add', '.')
        commit_fixture(self.root, 'fixture text diff with nul')
        git(self.root, 'tag', 'v4.0.0')
        results, values, _ = execute(self.root, 'v4.0.0')
        self.assertTrue(all(r.returncode == 0 for r in results))
        self.assertNotIn('\x00', values['changes_diff'])
        self.assertIn('+ab', values['changes_diff'])

    def test_large_nul_diff_keeps_the_truncation_notice(self):
        git(self.root, 'tag', '-d', 'v1.0.0')
        (self.root / '.gitattributes').write_text('nul.txt diff\n')
        (self.root / 'nul.txt').write_bytes(b'\x00' + b'a' * 150000 + b'\n')
        commit_fixture(self.root, 'fixture large text diff with nul')
        git(self.root, 'tag', 'v5.0.0')
        results, values, leftovers = execute(self.root, 'v5.0.0')
        self.assertTrue(all(result.returncode == 0 for result in results))
        suffix = '\n\n... [diff truncated at 100000 characters]'
        self.assertTrue(values['changes_diff'].endswith(suffix))
        self.assertNotIn('\x00', values['changes_diff'])
        self.assertLessEqual(len(values['changes_diff']), 100000 + len(suffix))
        self.assertEqual(leftovers, [])

    def test_collector_requires_no_credentials_or_generation_inputs(self):
        self.assertEqual(set(ACTION['inputs']), {'release-tag', 'release-notes'})
        self.assertEqual(set(ACTION['outputs']), {
            'version', 'release_tag', 'previous_tag', 'release_notes', 'changes_diff', 'reviewers',
        })
        self.assertTrue(all(step['shell'] == 'bash' for step in ACTION['runs']['steps']))


if __name__ == '__main__':
    unittest.main()
