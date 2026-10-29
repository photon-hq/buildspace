import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
DEFAULTS = {
    'commit-user-name': 'photon-release[bot]',
    'commit-user-email': 'photon-release[bot]@users.noreply.github.com',
}
AUTHOR_ENV = {
    'COMMIT_USER_NAME': 'commit-user-name',
    'COMMIT_USER_EMAIL': 'commit-user-email',
}
BLOCKS = {
    name: yaml.load((ROOT / f'.github/blocks/{name}/action.yaml').read_text(), Loader=yaml.BaseLoader)
    for name in ('bump-npm-version', 'sync-crates-version', 'bump-monorepo-versions', 'update-tap')
}


def author_step(block):
    return next(step for step in block['runs']['steps'] if 'git config user.name' in step.get('run', ''))


class ReleaseCommitAuthorTests(unittest.TestCase):
    def test_all_blocks_keep_the_existing_author_as_optional_defaults(self):
        for name, block in BLOCKS.items():
            for key, default in DEFAULTS.items():
                with self.subTest(block=name, input=key):
                    self.assertEqual(block['inputs'][key]['required'], 'false')
                    self.assertEqual(block['inputs'][key]['default'], default)

    def test_author_values_reach_git_only_through_quoted_environment_variables(self):
        for name, block in BLOCKS.items():
            with self.subTest(block=name):
                step = author_step(block)
                for variable, key in AUTHOR_ENV.items():
                    self.assertEqual(step['env'][variable], '${{ inputs.' + key + ' }}')
                commands = [line.strip() for line in step['run'].splitlines() if line.strip().startswith('git config user.')]
                self.assertEqual(commands, [
                    'git config user.name "$COMMIT_USER_NAME"',
                    'git config user.email "$COMMIT_USER_EMAIL"',
                ])
                for item in block['runs']['steps']:
                    self.assertNotRegex(item.get('run', ''), r'\$\{\{\s*inputs\.commit-user-(name|email)\b')

    def test_every_workflow_caller_forwards_optional_string_inputs(self):
        callers = set()
        seen_blocks = set()
        for path in sorted((ROOT / '.github/workflows').glob('*')):
            if path.suffix not in ('.yml', '.yaml'):
                continue
            workflow = yaml.load(path.read_text(), Loader=yaml.BaseLoader)
            for job in workflow.get('jobs', {}).values():
                for step in job.get('steps', []):
                    block_name = step.get('uses', '').split('@')[0].rsplit('/', 1)[-1]
                    if block_name not in BLOCKS:
                        continue
                    callers.add(path.name)
                    seen_blocks.add(block_name)
                    for key, default in DEFAULTS.items():
                        with self.subTest(workflow=path.name, block=block_name, input=key):
                            declaration = workflow['on']['workflow_call']['inputs'][key]
                            self.assertEqual(declaration['type'], 'string')
                            self.assertEqual(declaration['required'], 'false')
                            self.assertEqual(declaration['default'], default)
                            self.assertEqual(step['with'][key], '${{ inputs.' + key + ' }}')
        self.assertEqual(seen_blocks, set(BLOCKS))
        self.assertEqual(callers, {
            'typescript-service-release.yaml', 'typescript-monorepo-release.yaml',
            'rust-service-release.yaml', 'go-service-release.yaml',
        })

    def test_git_config_commands_produce_default_custom_and_literal_authors(self):
        cases = (
            {},
            {'commit-user-name': 'Acme Release Bot', 'commit-user-email': 'release@acme.example'},
            {
                'commit-user-name': 'Acme $(touch injected-name) `touch injected-backtick`',
                'commit-user-email': 'release+$(touch injected-email)@acme.example',
            },
        )
        for name, block in BLOCKS.items():
            step = author_step(block)
            commands = '\n'.join(line for line in step['run'].splitlines() if line.startswith('git config user.'))
            for overrides in cases:
                with self.subTest(block=name, author=overrides), tempfile.TemporaryDirectory() as directory:
                    values = {key: item['default'] for key, item in block['inputs'].items() if key in DEFAULTS}
                    values.update(overrides)
                    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
                    env.update({'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1'})
                    env.update({variable: values[key] for variable, key in AUTHOR_ENV.items()})
                    subprocess.run(['git', 'init', '--quiet', directory], env=env, check=True, capture_output=True)
                    subprocess.run(['bash', '-euo', 'pipefail', '-c', commands], cwd=directory, env=env, check=True, capture_output=True)
                    subprocess.run(['git', 'commit', '--quiet', '--allow-empty', '-m', 'Test release author'],
                                   cwd=directory, env=env, check=True, capture_output=True)
                    identity = subprocess.run(['git', 'show', '-s', '--format=%an%n%ae%n%cn%n%ce'],
                                              cwd=directory, env=env, check=True, capture_output=True, text=True).stdout.splitlines()
                    self.assertEqual(identity, [values[key] for key in DEFAULTS] * 2)
                    self.assertFalse(any(Path(directory).glob('injected-*')))

    def test_readme_documents_author_defaults_for_each_block_and_workflow(self):
        readme = (ROOT / 'README.md').read_text()
        for heading in (*BLOCKS, 'Rust Service Release', 'TypeScript Service Release',
                        'TypeScript Monorepo Release', 'Go Binary Release'):
            with self.subTest(section=heading):
                section = readme.split(f'\n### {heading}\n', 1)[1].split('\n### ', 1)[0]
                for key, default in DEFAULTS.items():
                    self.assertIn(f'| `{key}` | string | No | `{default}` |', section)


if __name__ == '__main__':
    unittest.main()
