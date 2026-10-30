import json
from pathlib import Path
import subprocess
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = yaml.load((ROOT / '.github/blocks/check-pr-label/action.yaml').read_text(), Loader=yaml.BaseLoader)['runs']['steps'][0]['with']['script']
RUNNER = r'''
const fs = require('node:fs');
const data = JSON.parse(fs.readFileSync(0, 'utf8'));
process.env.LABELS_TO_CHECK = data.labels || '["release", "prerelease"]';
const outputs = {}, calls = [], errors = [];
const association = async () => {};
const github = {
  rest: {repos: {listPullRequestsAssociatedWithCommit: association}, pulls: {get: async options => {
    calls.push(['get', options]);
    if (data.getError) throw new Error('get failed');
    return {data: {labels: data.prLabels || [{name: 'Release'}]}};
  }}},
  paginate: async (method, options) => {
    calls.push(['paginate', options]);
    if (method !== association) throw new Error('wrong API');
    if (data.listError) throw new Error('lookup failed');
    const result = [];
    for (const [index, page] of (data.pages || []).entries()) {
      if (data.failPage === index + 1) throw new Error('page lookup failed');
      result.push(...page);
    }
    return result;
  }
};
const context = {eventName: data.event || 'push', repo: {owner: 'fixture', repo: 'caller'},
  ref: data.ref || 'refs/heads/main', sha: data.sha || 'target',
  payload: {pull_request: {number: 4, labels: data.payloadLabels || [{name: 'Prerelease'}]}}};
const core = {setOutput: (key, value) => outputs[key] = value};
console.log = () => {};
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
(async () => {
  try {await new AsyncFunction('github', 'context', 'core', data.script)(github, context, core);}
  catch (error) {errors.push(error.message);}
  process.stdout.write(JSON.stringify({outputs, calls, errors}));
})();
'''


def pr(number=11, merge='target', branch='main', merged=True):
    return {'number': number, 'merge_commit_sha': merge, 'merged_at': '2026-10-27' if merged else None, 'base': {'ref': branch}}


def execute(**values):
    result = subprocess.run(['node', '-e', RUNNER], input=json.dumps({'script': SCRIPT, **values}),
                            text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


class AssociationTests(unittest.TestCase):
    def test_target_outside_latest_ten_closed_prs_is_found_by_commit(self):
        result = execute(pages=[[pr(i, merge=f'other-{i}', merged=False) for i in range(10)], [pr()]])
        self.assertEqual(result['errors'], [])
        self.assertTrue(json.loads(result['outputs']['labels'])['release'])
        self.assertEqual(result['calls'][0][1]['commit_sha'], 'target')

    def test_merge_squash_and_rebase_associations(self):
        for method in ('merge', 'squash', 'rebase'):
            with self.subTest(method=method):
                sha = f'{method}-result'
                result = execute(sha=sha, pages=[[pr(merge=sha)]])
                self.assertEqual(result['errors'], [])
                self.assertTrue(json.loads(result['outputs']['labels'])['release'])
                self.assertEqual(result['calls'][0][1]['commit_sha'], sha)

    def test_open_or_other_base_pr_does_not_supply_release_label(self):
        for candidate in (pr(merged=False), pr(branch='other'), pr(merge='unrelated-commit')):
            result = execute(pages=[[candidate]])
            self.assertEqual(result['errors'], [])
            self.assertFalse(json.loads(result['outputs']['labels'])['release'])

    def test_push_with_no_associated_pr_has_no_labels(self):
        result = execute()
        self.assertEqual(result['errors'], [])
        self.assertEqual(json.loads(result['outputs']['labels']), {'release': False, 'prerelease': False})

    def test_api_error_never_emits_results(self):
        for error in ('listError', 'getError'):
            result = execute(pages=[[pr()]], **{error: True})
            self.assertEqual(result['outputs'], {})
            self.assertTrue(result['errors'])

    def test_later_page_failure_never_emits_results(self):
        for pages in ([[pr(merged=False)], [pr()]], [[pr()], []]):
            result = execute(pages=pages, failPage=2)
            self.assertTrue(result['errors'])
            self.assertEqual(result['outputs'], {})

    def test_ambiguous_merged_associations_require_resolution(self):
        result = execute(pages=[[pr(1), pr(2)]])
        self.assertEqual(result['outputs'], {})
        self.assertTrue(result['errors'])
        exact = execute(pages=[[pr(1, merge='a'), pr(2)]])
        self.assertEqual(exact['calls'][-1][1]['pull_number'], 2)
        duplicated = execute(pages=[[pr(1)], [pr(2)]])
        self.assertEqual(duplicated['outputs'], {})
        self.assertTrue(duplicated['errors'])

    def test_labels_keep_case_normalization_and_boolean_json(self):
        result = execute(labels='["ReLeAsE", "Prerelease"]', pages=[[pr()]],
                         prLabels=[{'name': 'RELEASE'}, {'name': 'Prerelease'}])
        self.assertEqual(result['errors'], [])
        self.assertEqual(json.loads(result['outputs']['labels']), {'release': True, 'prerelease': True})

    def test_generic_labels_do_not_imply_release_policy(self):
        result = execute(labels='["Needs-Review", "documentation"]', pages=[[pr()]],
                         prLabels=[{'name': 'NEEDS-REVIEW'}])
        self.assertEqual(result['errors'], [])
        self.assertEqual(json.loads(result['outputs']['labels']), {'needs-review': True, 'documentation': False})

    def test_prerelease_spellings_are_distinct_label_names(self):
        names = ['prerelease', 'pre release', 'pre-release']
        for name in names:
            with self.subTest(name=name):
                result = execute(labels=json.dumps(names), pages=[[pr()]], prLabels=[{'name': name.upper()}])
                self.assertEqual(result['errors'], [])
                self.assertEqual(json.loads(result['outputs']['labels']), {key: key == name for key in names})

    def test_manual_runs_use_the_same_commit_ownership_rules(self):
        owned = execute(event='workflow_dispatch', pages=[[pr()]])
        self.assertTrue(json.loads(owned['outputs']['labels'])['release'])
        for pages in ([], [[pr(merge='other')]]):
            result = execute(event='workflow_dispatch', pages=pages)
            self.assertEqual(result['errors'], [])
            self.assertFalse(json.loads(result['outputs']['labels'])['release'])

    def test_manual_feature_and_tag_refs_do_not_borrow_labels_or_disable_explicit_overrides(self):
        for ref, candidate in (('refs/heads/feature', pr(merged=False)), ('refs/tags/v1.0.0', pr())):
            result = execute(event='workflow_dispatch', ref=ref, pages=[[candidate]])
            self.assertEqual(result['errors'], [])
            self.assertEqual(json.loads(result['outputs']['labels']), {'release': False, 'prerelease': False})
            self.assertEqual([call[0] for call in result['calls']], ['paginate'])

    def test_pull_request_payload_keeps_label_behavior(self):
        result = execute(event='pull_request')
        self.assertEqual(result['calls'], [])
        self.assertEqual(json.loads(result['outputs']['labels']), {'release': False, 'prerelease': True})
        unlabeled = execute(event='pull_request', payloadLabels=[])
        self.assertEqual(unlabeled['calls'], [])
        self.assertEqual(json.loads(unlabeled['outputs']['labels']), {'release': False, 'prerelease': False})

    def test_bad_input_fails_without_api_calls(self):
        for labels in ('{', '{}', '[4]', '[""]'):
            result = execute(labels=labels)
            self.assertTrue(result['errors'])
            self.assertEqual(result['calls'], [])


if __name__ == '__main__':
    unittest.main()
