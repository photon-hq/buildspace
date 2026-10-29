import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import yaml
from git_fixture import commit_fixture


ROOT = Path(__file__).resolve().parents[1]
STEPS = yaml.load((ROOT / '.github/blocks/update-docs/action.yaml').read_text(), Loader=yaml.BaseLoader)['runs']['steps']


class DocsPublishTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='docs-publish-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.owned = self.root / 'runner/buildspace-docs.fixture'
        self.docs = self.owned / 'repo'
        (self.docs / '.git').mkdir(parents=True)
        (self.docs / '.git/config').write_text('[remote "origin"]\nurl = https://github.com/fixture/docs.git\n')
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.output = self.root / 'outputs'
        self.output.touch()
        self.log = self.root / 'commands'
        self.env = {
            'PATH': f'{self.bin}:{os.defpath}', 'HOME': str(self.root),
            'RUNNER_TEMP': str(self.root / 'runner'), 'GITHUB_OUTPUT': str(self.output),
            'DOCS_DIR': str(self.docs), 'DOCS_TEMP': str(self.owned),
            'DOCS_REPO': 'fixture/docs', 'DOCS_BRANCH': 'main',
            'SERVICE_NAME': 'fixture-service', 'VERSION': '1.2.3', 'RELEASE_TAG': 'v1.2.3',
            'RELEASE_NOTES': 'fixture notes', 'SOURCE_REPO': 'fixture/service',
            'SOURCE_SERVER': 'https://github.com', 'GH_TOKEN': 'SYNTHETIC_PUBLISH_SENTINEL',
            'COMMAND_LOG': str(self.log),
        }
        self.stub('git', '''
import base64
args = sys.argv[1:]
assert args[0] in ('config', 'checkout', 'add', 'commit', 'push')
expected = 'AUTHORIZATION: basic ' + base64.b64encode(('x-access-token:' + os.environ['GH_TOKEN']).encode()).decode()
record['authenticated'] = os.environ.get('GIT_CONFIG_VALUE_1') == expected
record['helper_disabled'] = os.environ.get('GIT_CONFIG_VALUE_0') == ''
record['config_count'] = os.environ.get('GIT_CONFIG_COUNT')
save()
sys.exit(int(os.environ.get('PUSH_EXIT', '0')) if args[0] == 'push' else 0)
''')
        self.stub('gh', '''
assert sys.argv[1:3] in (['pr', 'list'], ['pr', 'view'], ['pr', 'create'])
save()
if sys.argv[2] == 'list':
    print(os.environ.get('EXISTING_PR', ''))
    sys.exit(int(os.environ.get('LOOKUP_EXIT', '0')))
if sys.argv[2] == 'view':
    print(os.environ.get('EXISTING_HEAD', 'a' * 40))
    sys.exit(int(os.environ.get('HEAD_LOOKUP_EXIT', '0')))
print('https://github.com/fixture/docs/pull/1')
sys.exit(int(os.environ.get('CREATE_EXIT', '0')))
''')

    def stub(self, name, body):
        path = self.bin / name
        path.write_text('''#!/usr/bin/env python3
import json
import os
import sys
record = {'command': os.path.basename(sys.argv[0]), 'args': sys.argv[1:]}
def save():
    with open(os.environ['COMMAND_LOG'], 'a') as log:
        log.write(json.dumps(record) + '\\n')
''' + body)
        path.chmod(0o755)

    def execute(self, **env):
        script = next(step['run'] for step in STEPS if step.get('id') == 'create-pr')
        return subprocess.run(['bash', '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script],
                              cwd=self.docs, env=self.env | env, text=True, capture_output=True)

    def commands(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_failed_pr_lookup_stops_before_git_writes(self):
        result = self.execute(LOOKUP_EXIT='19')
        self.assertEqual(result.returncode, 19)
        self.assertEqual([(item['command'], item['args'][:2]) for item in self.commands()], [('gh', ['pr', 'list'])])
        self.assertEqual(self.output.read_text(), '')

    def test_push_auth_is_transient_and_not_exposed_in_arguments_or_outputs(self):
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.commands()
        self.assertEqual(commands[0]['args'][:2], ['pr', 'list'])
        pushes = [item for item in commands if item['command'] == 'git' and item['args'][0] == 'push']
        self.assertEqual(len(pushes), 1)
        self.assertTrue(pushes[0]['authenticated'])
        self.assertTrue(pushes[0]['helper_disabled'])
        self.assertEqual(pushes[0]['config_count'], '2')
        for command in commands:
            if command['command'] == 'git' and command['args'][0] != 'push':
                self.assertIsNone(command['config_count'])
        self.assertEqual(commands[-1]['args'][:2], ['pr', 'create'])
        self.assertEqual(self.output.read_text(), 'pr-url=https://github.com/fixture/docs/pull/1\n')
        self.assertFalse((self.owned / 'pr-body.md').exists())
        captured = result.stdout + result.stderr + self.log.read_text() + self.output.read_text()
        captured += (self.docs / '.git/config').read_text()
        for secret in (self.env['GH_TOKEN'], base64.b64encode(f"x-access-token:{self.env['GH_TOKEN']}".encode()).decode()):
            self.assertNotIn(secret, captured)

    def test_existing_pr_url_is_reused_without_creating_another_pr(self):
        result = self.execute(EXISTING_PR='https://github.com/fixture/docs/pull/2')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.output.read_text(), 'pr-url=https://github.com/fixture/docs/pull/2\n')
        self.assertFalse(any(item['args'][:2] == ['pr', 'create'] for item in self.commands()))

    def test_failed_existing_head_lookup_stops_before_git_writes(self):
        result = self.execute(EXISTING_PR='https://github.com/fixture/docs/pull/2', HEAD_LOOKUP_EXIT='29')
        self.assertEqual(result.returncode, 29)
        self.assertEqual([(item['command'], item['args'][:2]) for item in self.commands()],
                         [('gh', ['pr', 'list']), ('gh', ['pr', 'view'])])
        self.assertEqual(self.output.read_text(), '')

    def test_push_lease_pins_the_observed_head_or_requires_a_new_branch(self):
        for head in ('', 'a' * 40):
            with self.subTest(head=head):
                self.log.unlink(missing_ok=True)
                self.output.write_text('')
                result = self.execute(EXISTING_PR='https://github.com/fixture/docs/pull/2' if head else '',
                                      EXISTING_HEAD=head)
                self.assertEqual(result.returncode, 0, result.stderr)
                push = next(item for item in self.commands()
                            if item['command'] == 'git' and item['args'][0] == 'push')
                self.assertIn(f'--force-with-lease=refs/heads/docs/update-fixture-service-v1.2.3:{head}', push['args'])

    def test_real_single_branch_clone_retries_and_rejects_a_stale_head(self):
        (self.bin / 'git').unlink()
        source = self.root / 'source'
        source.mkdir()
        subprocess.run(['git', 'init', '-q', '-b', 'main', str(source)], check=True, capture_output=True)
        (source / 'README.md').write_text('fixture docs\n')
        commit_fixture(source, 'fixture source')
        remote = self.root / 'origin.git'
        subprocess.run(['git', 'clone', '--bare', str(source), str(remote)], check=True, capture_output=True)
        config = self.root / 'fixture.gitconfig'
        config.write_text(f'[url "file://{remote}"]\n\tinsteadOf = https://github.com/fixture/docs.git\n')
        self.env['GIT_CONFIG_GLOBAL'] = str(config)
        branch = 'docs/update-fixture-service-v1.2.3'
        clone = next(step['run'] for step in STEPS if step.get('id') == 'clone-docs')

        def publish(marker, expected=None):
            self.output.write_text('')
            result = subprocess.run(['bash', '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', clone],
                                    cwd=self.root, env=self.env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            values = dict(line.split('=', 1) for line in self.output.read_text().splitlines())
            self.docs = Path(values['docs-dir'])
            self.env['DOCS_DIR'] = str(self.docs)
            tracking = subprocess.run(['git', '-C', str(self.docs), 'rev-parse', '--verify',
                                       f'refs/remotes/origin/{branch}'], env=self.env, capture_output=True)
            self.assertNotEqual(tracking.returncode, 0)
            (self.docs / 'README.md').write_text(f'fixture docs: {marker}\n')
            self.output.write_text('')
            return self.execute(EXISTING_PR='https://github.com/fixture/docs/pull/1' if expected else '',
                                EXISTING_HEAD=expected or '')

        def remote_head():
            return subprocess.check_output(['git', '--git-dir', str(remote), 'rev-parse',
                                            f'refs/heads/{branch}'], text=True, env=self.env).strip()

        first = publish('first')
        self.assertEqual(first.returncode, 0, first.stderr)
        first_head = remote_head()
        second = publish('second', first_head)
        self.assertEqual(second.returncode, 0, second.stderr)
        second_head = remote_head()
        self.assertNotEqual(first_head, second_head)
        self.assertEqual(self.output.read_text(), 'pr-url=https://github.com/fixture/docs/pull/1\n')
        stale = publish('stale retry', first_head)
        self.assertNotEqual(stale.returncode, 0)
        self.assertIn('stale info', stale.stderr)
        self.assertEqual(remote_head(), second_head)
        self.assertEqual(self.output.read_text(), '')

    def test_push_and_create_failures_emit_no_success_output(self):
        for failure in ('PUSH_EXIT', 'CREATE_EXIT'):
            with self.subTest(failure=failure):
                self.log.unlink(missing_ok=True)
                self.output.write_text('')
                result = self.execute(**{failure: '25'})
                self.assertEqual(result.returncode, 25)
                self.assertEqual(self.output.read_text(), '')
                if failure == 'PUSH_EXIT':
                    self.assertFalse(any(item['args'][:2] == ['pr', 'create'] for item in self.commands()))


if __name__ == '__main__':
    unittest.main()
