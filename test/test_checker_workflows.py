import unittest
from pathlib import Path

import yaml

from test_checkers import execute as check
from test_comment_lifecycle import execute as comment


ROOT = Path(__file__).resolve().parents[1]


class CheckerWorkflowTests(unittest.TestCase):
    def workflow(self, kind):
        path = ROOT / f'.github/workflows/check-{kind}.yaml'
        return yaml.load(path.read_text(), Loader=yaml.BaseLoader)

    def test_workflows_keep_the_existing_jobs_permissions_and_blocking_flags(self):
        for kind in ('readme', 'skills'):
            workflow = self.workflow(kind)
            self.assertEqual(set(workflow['jobs']), {f'check-{kind}'})
            job = workflow['jobs'][f'check-{kind}']
            self.assertEqual(job['permissions'], {'contents': 'read', 'pull-requests': 'write'})
            inputs = workflow['on']['workflow_call']['inputs']
            flag = 'blocking' if kind == 'readme' else 'fail_on_missing_skills'
            self.assertEqual(inputs[flag]['default'], 'false')
            self.assertTrue(any(f'inputs.{flag}' in step.get('if', '') for step in job['steps']))

    def test_all_checker_and_comment_refs_use_the_same_immutable_action_revision(self):
        refs = set()
        for kind in ('readme', 'skills'):
            steps = self.workflow(kind)['jobs'][f'check-{kind}']['steps']
            uses = [step['uses'] for step in steps
                    if step.get('uses', '').startswith('photon-hq/buildspace/.github/blocks/')]
            self.assertEqual(len(uses), 3)
            for use in uses:
                self.assertRegex(use, r'@[a-f0-9]{40}$')
                refs.add(use.rsplit('@', 1)[1])
        self.assertEqual(len(refs), 1)

    def test_warning_survives_unknown_results_then_clears_on_a_complete_clean_result(self):
        for kind in ('readme', 'skills'):
            steps = self.workflow(kind)['jobs'][f'check-{kind}']['steps']
            clear = next(step for step in steps if step.get('with', {}).get('state') == 'absent')
            flag, clean = ('up-to-date', 'true') if kind == 'readme' else ('needs-update', 'false')
            self.assertEqual(clear['if'], f"steps.check.outputs.{flag} == '{clean}'")
            self.assertEqual(clear['with']['comment-key'], f'check-{kind}')
            parsed = check(kind, 'parse', env={'RAW_OUTPUT': 'VERDICT: NEEDS_UPDATE\nREASON: Update the public contract.'})
            self.assertEqual(parsed['errors'], [])
            self.assertNotEqual(parsed['outputs'][flag], clean)
            posted = comment(key=f'check-{kind}')
            self.assertEqual(posted['errors'], [])
            warning = {'id': 101, 'body': posted['calls'][-1][1]['body']}
            pages = [[{'id': i, 'body': 'unrelated'} for i in range(100)], [warning]]
            for raw in ('', 'UP_TO_DATE', 'VERDICT: UP_TO_DATE\nREASON: '):
                parsed = check(kind, 'parse', env={'RAW_OUTPUT': raw})
                self.assertTrue(parsed['errors'])
                self.assertNotEqual(parsed['outputs'].get(flag), clean)
                self.assertEqual(pages[-1], [warning])
            for verdict in ('UP_TO_DATE', *(['IRRELEVANT'] if kind == 'skills' else [])):
                parsed = check(kind, 'parse', env={'RAW_OUTPUT': f'VERDICT: {verdict}\nREASON: The contract is documented.'})
                self.assertEqual(parsed['errors'], [])
                self.assertEqual(parsed['outputs'][flag], clean)
                removed = comment(state=clear['with']['state'], key=clear['with']['comment-key'], pages=pages)
                self.assertEqual(removed['errors'], [])
                self.assertEqual(removed['calls'][-1][0], 'deleteComment')
                self.assertEqual(removed['calls'][-1][1]['comment_id'], warning['id'])


if __name__ == '__main__':
    unittest.main()
