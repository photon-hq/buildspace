import json
from pathlib import Path
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / '.github/workflows'
RELEASE = 'fromJSON(needs.check-labels.outputs.labels).release'
PRERELEASE = 'fromJSON(needs.check-labels.outputs.labels).prerelease'
COMPATIBILITY = {
    'release.yaml': ('release-info', f'{RELEASE} || inputs.release', ['release']),
    'typescript-service-release.yaml': ('release-info', f'{RELEASE} || inputs.release', ['release', 'prerelease']),
    'typescript-monorepo-release.yaml': ('detect-changes', f'{RELEASE} || inputs.release || inputs.prerelease || {PRERELEASE}', ['release', 'prerelease']),
    'rust-service-release.yaml': ('release-info', f'{RELEASE} || inputs.release', ['release', 'prerelease']),
    'go-service-release.yaml': ('release-info', f'{RELEASE} || inputs.release', ['release', 'prerelease']),
    'swift-release.yml': ('prepare-release', f'{RELEASE} || {PRERELEASE} || inputs.release || inputs.prerelease', ['release', 'prerelease']),
    'pkg-release.yml': ('prepare-release', RELEASE, ['release']),
    'makefile-dylib-release.yml': ('prepare-release', RELEASE, ['release']),
}


class ReleaseLabelPolicyTests(unittest.TestCase):
    def workflow(self, name):
        return yaml.load((WORKFLOWS / name).read_text(), Loader=yaml.BaseLoader)

    def test_buildspace_itself_has_no_label_driven_release(self):
        for path in WORKFLOWS.iterdir():
            workflow = self.workflow(path.name)
            if not set(workflow['on']) - {'workflow_call'}:
                continue
            with self.subTest(workflow=path.name):
                self.assertNotIn('check-pr-label', json.dumps(workflow))
                for job in workflow['jobs'].values():
                    caller = job.get('uses', '').split('@', 1)[0].rsplit('/', 1)[-1]
                    self.assertNotIn(caller, COMPATIBILITY)

    def test_stage_and_promote_have_no_pr_label_authorization(self):
        for name in ('package-stage.yml', 'package-promote.yml', 'swift-stage.yml', 'swift-promote.yml'):
            with self.subTest(workflow=name):
                workflow = self.workflow(name)
                inputs = workflow['on']['workflow_call']['inputs']
                self.assertTrue(set(inputs).isdisjoint({'labels-to-check', 'default-on-push', 'release', 'prerelease'}))
                content = json.dumps(workflow)
                for marker in ('check-pr-label', 'needs.check-labels', 'inputs.labels-to-check',
                               'inputs.release', 'inputs.prerelease', 'github.event.pull_request.labels'):
                    self.assertNotIn(marker, content)

    def test_live_compatibility_gates_and_detector_contracts_remain_intact(self):
        for name, (entry, gate, labels) in COMPATIBILITY.items():
            with self.subTest(workflow=name):
                workflow = self.workflow(name)
                inputs = workflow['on']['workflow_call']['inputs']
                job = workflow['jobs']['check-labels']
                self.assertEqual(job['outputs'], {'labels': '${{ steps.check.outputs.labels }}'})
                self.assertEqual(job['permissions'], {'pull-requests': 'read', 'contents': 'read'})
                check = next(step for step in job['steps'] if step.get('id') == 'check')
                self.assertEqual(check['uses'], 'photon-hq/buildspace/.github/blocks/check-pr-label@main')
                if 'labels-to-check' in inputs:
                    self.assertEqual(inputs['labels-to-check']['type'], 'string')
                    self.assertEqual(json.loads(inputs['labels-to-check']['default']), labels)
                    self.assertEqual(check['with'], {'labels': '${{ inputs.labels-to-check }}'})
                else:
                    self.assertEqual(json.loads(check['with']['labels']), labels)
                    self.assertNotIn('default-on-push', check['with'])
                for flag in ('release', 'prerelease'):
                    if flag in inputs:
                        self.assertEqual(inputs[flag]['type'], 'boolean')
                        self.assertEqual(inputs[flag]['default'], 'false')
                self.assertEqual(workflow['jobs'][entry]['needs'], 'check-labels')
                self.assertEqual(workflow['jobs'][entry]['if'], gate)

    def test_inventory_covers_every_remaining_internal_detector_consumer(self):
        consumers = {path.name for path in WORKFLOWS.iterdir()
                     if '/blocks/check-pr-label@' in path.read_text()}
        self.assertEqual(consumers, set(COMPATIBILITY))
        inventory = (ROOT / 'docs/release-label-compatibility.md').read_text()
        for name in consumers:
            self.assertIn(f'`{name}`', inventory)


if __name__ == '__main__':
    unittest.main()
