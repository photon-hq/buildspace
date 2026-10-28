from pathlib import Path
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]


class ReleaseContextWorkflowTests(unittest.TestCase):
    def workflow(self, area):
        return yaml.load((ROOT / f'.github/workflows/update-{area}.yaml').read_text(), Loader=yaml.BaseLoader)

    def test_collectors_use_full_checkout_read_only_permissions_and_one_immutable_revision(self):
        refs = set()
        for area in ('docs', 'skills'):
            gather = self.workflow(area)['jobs']['gather-changes']
            self.assertEqual(gather['permissions'], {'contents': 'read'})
            self.assertEqual(len(gather['steps']), 2)
            checkout, context = gather['steps']
            self.assertTrue(checkout['uses'].startswith('actions/checkout@'))
            self.assertEqual(checkout['with']['fetch-depth'], '0')
            self.assertEqual(context['id'], 'context')
            self.assertRegex(context['uses'], r'^photon-hq/buildspace/.github/blocks/collect-release-context@[a-f0-9]{40}$')
            self.assertEqual(set(context['with']), {'release-tag', 'release-notes'})
            refs.add(context['uses'].rsplit('@', 1)[1])
            for key in ('version', 'release_tag', 'release_notes', 'changes_diff', 'reviewers'):
                self.assertEqual(gather['outputs'][key], '${{ steps.context.outputs.' + key + ' }}')
        self.assertEqual(len(refs), 1)

    def test_release_event_and_explicit_override_expressions_are_preserved(self):
        docs = self.workflow('docs')['jobs']['gather-changes']['steps'][1]['with']
        self.assertEqual(docs['release-tag'], '${{ github.event.release.tag_name }}')
        self.assertEqual(docs['release-notes'], '${{ github.event.release.body }}')
        skills = self.workflow('skills')['jobs']['gather-changes']['steps'][1]['with']
        self.assertEqual(skills['release-tag'], '${{ inputs.release-tag || github.event.release.tag_name }}')
        self.assertEqual(skills['release-notes'], '${{ inputs.release-notes || github.event.release.body }}')

    def test_skills_still_skips_by_default_and_failed_collection_cannot_start_generation(self):
        skills = self.workflow('skills')
        self.assertEqual(skills['on']['workflow_call']['inputs']['skills-need-update']['default'], 'false')
        self.assertEqual(skills['jobs']['gather-changes']['if'], 'inputs.skills-need-update')
        for area in ('docs', 'skills'):
            update = self.workflow(area)['jobs'][f'update-{area}']
            self.assertEqual(update['needs'], 'gather-changes')
            self.assertNotIn('always()', update.get('if', ''))


if __name__ == '__main__':
    unittest.main()
