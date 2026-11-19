import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
BLOCK = yaml.load(
    (ROOT / '.github/blocks/typescript-install/action.yaml').read_text(),
    Loader=yaml.BaseLoader,
)
STEPS = BLOCK['runs']['steps']


class TypeScriptInstallBlockTests(unittest.TestCase):
    def test_setup_preserves_package_manager_resolution_and_cache_inputs(self):
        pnpm = next(step for step in STEPS if step.get('name') == 'Set up pnpm')
        node = next(step for step in STEPS if step.get('name') == 'Set up Node.js')
        self.assertEqual(pnpm['with']['version'], '${{ inputs.pnpm-version }}')
        self.assertEqual(pnpm['with']['run_install'], 'false')
        self.assertEqual(node['with']['cache'], 'pnpm')
        self.assertEqual(node['with']['cache-dependency-path'], '${{ inputs.cache-dependency-path }}')

    def test_install_is_last_and_limits_registry_credentials_to_that_step(self):
        checkout, pnpm, node, install = STEPS
        self.assertEqual(checkout['uses'], 'actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10')
        self.assertEqual(pnpm['uses'], 'pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1')
        self.assertEqual(node['uses'], 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020')
        self.assertEqual(install['env'], {
            'BUF_TOKEN': '${{ inputs.buf-token }}',
            'NODE_AUTH_TOKEN': '${{ github.token }}',
        })
        self.assertEqual(install['run'], '${{ inputs.install-command }}')
        self.assertIn('--frozen-lockfile', BLOCK['inputs']['install-command']['default'])
        self.assertEqual(install['shell'], 'bash')

    def test_callers_can_select_a_nested_working_directory_without_changing_cache_contract(self):
        self.assertEqual(BLOCK['inputs']['working-directory']['default'], '.')
        self.assertEqual(BLOCK['inputs']['cache-dependency-path']['default'], 'pnpm-lock.yaml')
        self.assertEqual(BLOCK['inputs']['install-command']['default'], 'pnpm install --frozen-lockfile --config.//buf.build/gen/npm/v1/:_authToken="$BUF_TOKEN"')


if __name__ == '__main__':
    unittest.main()
