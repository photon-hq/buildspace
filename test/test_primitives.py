from pathlib import Path
import re
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
CONTRACTS = {
    'rust-build': (('binary-name', 'binary-path', 'target', 'build-env'), ('artifact-name', 'artifact-path')),
    'go-build': (('binary-name', 'go-version', 'goos', 'goarch', 'build-flags', 'ldflags'), ('artifact-name', 'artifact-path')),
    'swift-build': (('binary-name', 'compile-env', 'use-cache', 'resource-bundles', 'entitlements', 'github-token'), ('binary-path', 'resource-bundles-path')),
    'swift-pkg': (('swift-binary-path', 'identifier', 'version', 'package-name', 'developer-id-installer-name', 'allow-unsigned', 'scripts-path', 'payload-path', 'resource-bundles-path'), ()),
    'build-makefile-dylib': (('output-name', 'version'), ()),
    'publish-npm': (('bun-version', 'node-version', 'working-directory', 'build-command', 'tag', 'dry-run', 'publish-command', 'npm-token'), ()),
    'publish-npm-packages': (('changed-packages', 'bun-version', 'node-version', 'tag', 'build-command', 'root-build-command', 'dry-run', 'npm-token'), ()),
    'publish-github-package': (('bun-version', 'node-version', 'working-directory', 'build-command', 'tag', 'dry-run', 'publish-command', 'github-token'), ()),
    'publish-github-packages': (('changed-packages', 'bun-version', 'node-version', 'tag', 'build-command', 'root-build-command', 'dry-run', 'github-token'), ()),
    'publish-crates': (('crates', 'dry-run', 'cargo-registry-token'), ()),
}


def action(directory):
    return yaml.load(next(directory.glob('action.y*ml')).read_text(), Loader=yaml.BaseLoader)


class PrimitiveContracts(unittest.TestCase):
    def test_compatibility_recipes_keep_their_existing_inputs_and_output_names(self):
        for name, (inputs, outputs) in CONTRACTS.items():
            with self.subTest(block=name):
                block = action(ROOT / '.github/blocks' / name)
                self.assertEqual(tuple(block['inputs']), inputs)
                self.assertEqual(tuple(block.get('outputs', {})), outputs)
                for key in ('dry-run', 'allow-unsigned'):
                    if key in block['inputs']:
                        self.assertEqual(block['inputs'][key]['default'], 'false')

    def test_each_primitive_has_one_native_entrypoint_and_documented_data_contracts(self):
        directories = sorted(path for path in (ROOT / '.github/primitives').iterdir() if path.is_dir())
        self.assertEqual(len(directories), 9)
        for directory in directories:
            with self.subTest(primitive=directory.name):
                primitive = action(directory)
                self.assertEqual(primitive['runs'], {'using': 'node24', 'main': 'index.mjs'})
                self.assertTrue((directory / 'index.mjs').is_file())
                for item in (*primitive['inputs'].values(), *primitive.get('outputs', {}).values()):
                    self.assertTrue(item['description'])
                self.assertNotIn('photon', yaml.dump(primitive).lower())

    def test_same_revision_references_resolve_and_have_no_cycles_or_unknown_inputs(self):
        graph = {}
        documents = [*ROOT.glob('.github/blocks/*/action.y*ml'), *ROOT.glob('.github/primitives/*/action.y*ml'), *ROOT.glob('.github/workflows/*.y*ml')]
        for path in documents:
            document = yaml.load(path.read_text(), Loader=yaml.BaseLoader)
            steps = document.get('runs', {}).get('steps', [])
            steps += [step for job in document.get('jobs', {}).values() for step in job.get('steps', [])]
            graph[path] = []
            for step in steps:
                reference = step.get('uses', '')
                if not reference.startswith('$/'):
                    continue
                self.assertNotIn('@', reference)
                target_directory = ROOT / reference[2:]
                target_path = next(target_directory.glob('action.y*ml'), None)
                self.assertIsNotNone(target_path, reference)
                target = action(target_directory)
                self.assertTrue(set(step.get('with', {})).issubset(target.get('inputs', {})), (path, reference))
                required = {name for name, field in target.get('inputs', {}).items() if field.get('required') == 'true' and 'default' not in field}
                self.assertTrue(required.issubset(step.get('with', {})), (path, reference, required))
                graph[path].append(target_path)

        def visit(path, ancestors):
            self.assertNotIn(path, ancestors, f'Action cycle at {path}')
            for target in graph[path]:
                visit(target, (*ancestors, path))

        for path in graph:
            visit(path, ())

    def test_refactored_recipes_never_float_to_main_inside_a_workflow(self):
        count = 0
        for path in ROOT.glob('.github/workflows/*.y*ml'):
            document = yaml.load(path.read_text(), Loader=yaml.BaseLoader)
            for job in document.get('jobs', {}).values():
                for step in job.get('steps', []):
                    reference = step.get('uses', '')
                    match = re.search(r'\.github/blocks/([^/@]+)', reference)
                    if match and match[1] in CONTRACTS:
                        self.assertEqual(reference, f'$/.github/blocks/{match[1]}', path)
                        count += 1
        self.assertGreater(count, 10)

    def test_oidc_policy_uses_publisher_results_without_hiding_swallowed_errors(self):
        steps = action(ROOT / '.github/blocks/publish-npm')['runs']['steps']
        oidc = next(step for step in steps if step.get('id') == 'oidc-publish')
        reject = next(step for step in steps if step.get('name') == 'Reject a publisher that swallowed an OIDC error')
        fallback = next(step for step in steps if step.get('name') == 'Publish via NPM token (fallback)')
        self.assertEqual(oidc['uses'], '$/.github/primitives/npm-publish')
        self.assertEqual(oidc['env'], {'NODE_AUTH_TOKEN': ''})
        self.assertEqual(oidc['continue-on-error'], 'true')
        self.assertEqual(reject['if'], "steps.oidc-publish.outcome == 'failure' && steps.oidc-publish.outputs.exit-code == '0'")
        self.assertIn('exit 1', reject['run'])
        self.assertEqual(fallback['if'], "steps.oidc-publish.outcome != 'success'")
        self.assertLess(steps.index(reject), steps.index(fallback))

    def test_registry_scope_mapping_stays_after_dependency_install_and_build(self):
        for name in ('publish-github-package', 'publish-github-packages'):
            steps = action(ROOT / '.github/blocks' / name)['runs']['steps']
            node = next(step for step in steps if step.get('uses', '').startswith('actions/setup-node@'))
            install = next(step for step in steps if step.get('name') == 'Install dependencies')
            build = next(step for step in steps if step.get('name') in ('Build', 'Build (root)'))
            self.assertGreater(steps.index(node), steps.index(install))
            self.assertGreater(steps.index(node), steps.index(build))

    def test_private_swift_dependencies_accept_the_secrets_the_token_step_reads(self):
        workflow = yaml.load((ROOT / '.github/workflows/swift-release.yml').read_text(), Loader=yaml.BaseLoader)
        secrets = workflow['on']['workflow_call']['secrets']
        token = next(step for step in workflow['jobs']['build']['steps'] if step.get('id') == 'app-token')
        self.assertEqual(token['if'], 'inputs.private-deps')
        for name in ('APP_ID', 'APP_PRIVATE_KEY'):
            self.assertEqual(secrets[name]['required'], 'false')
            self.assertIn(f'secrets.{name}', yaml.dump(token['with']))


if __name__ == '__main__':
    unittest.main()
