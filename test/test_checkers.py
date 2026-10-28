import json
from pathlib import Path
import subprocess
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
RUNNER = r'''
const fs = require('node:fs');
const data = JSON.parse(fs.readFileSync(0, 'utf8'));
Object.assign(process.env, data.env || {});
const outputs = {};
const errors = [];
const calls = [];
const core = {
  setOutput: (key, value) => outputs[key] = value,
  setFailed: (message) => errors.push(message),
  warning: (message) => calls.push(['warning', message])
};
const get = async () => {
  calls.push(['get']);
  if (data.getError) throw new Error('API get unavailable');
  return {data: {changed_files: data.total}};
};
const listFiles = async () => {throw new Error('single-page list is forbidden');};
const github = {
  rest: {pulls: {get, listFiles}},
  paginate: async (method, options) => {
    calls.push(['paginate', options]);
    if (method !== listFiles) throw new Error('unexpected API method');
    if (data.pageError) throw new Error('API page unavailable');
    return (data.pages || []).flat();
  }
};
const context = {repo: {owner: 'fixture', repo: 'caller'}, issue: {number: 123}};
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
(async () => {
  try {await new AsyncFunction('github', 'context', 'core', data.script)(github, context, core);}
  catch (error) {errors.push(error.message);}
  process.stdout.write(JSON.stringify({outputs, errors, calls}));
})();
'''


def definition(kind):
    return yaml.load((ROOT / f'.github/blocks/check-{kind}/action.yaml').read_text(), Loader=yaml.BaseLoader)


def execute(kind, step_id, **values):
    step = next(step for step in definition(kind)['runs']['steps'] if step.get('id') == step_id)
    result = subprocess.run(['node', '-e', RUNNER], input=json.dumps({'script': step['with']['script'], **values}),
                            text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


class CheckerTests(unittest.TestCase):
    def test_valid_verdicts_keep_existing_boolean_contract(self):
        for kind in ('readme', 'skills'):
            for verdict in ('UP_TO_DATE', 'NEEDS_UPDATE', *(['IRRELEVANT'] if kind == 'skills' else [])):
                with self.subTest(kind=kind, verdict=verdict):
                    result = execute(kind, 'parse', env={'RAW_OUTPUT': f'VERDICT: {verdict}\r\nREASON: Matches documented behavior.\r\n'})
                    self.assertEqual(result['errors'], [])
                    key = 'up-to-date' if kind == 'readme' else 'needs-update'
                    expected = verdict == ('UP_TO_DATE' if kind == 'readme' else 'NEEDS_UPDATE')
                    self.assertEqual(result['outputs'][key], str(expected).lower())
                    self.assertEqual(result['outputs']['explanation'], 'Matches documented behavior.')

    def test_unknown_results_emit_no_boolean_and_fail(self):
        for kind in ('readme', 'skills'):
            for raw in ('', ' ', 'no recognized answer', 'I think UP_TO_DATE is right',
                        'Unframed UP_TO_DATE\nREASON: Looks current.',
                        'VERDICT: UP_TO_DATE or NEEDS_UPDATE\nREASON: Looks current.',
                        'VERDICT: UP_TO_DATE', 'VERDICT: UP_TO_DATE\nREASON: ',
                        'VERDICT: NEEDS_UPDATE\nREASON: first\nVERDICT: UP_TO_DATE',
                        'VERDICT: IRRELEVANT\nREASON: no\nextra',
                        'VERDICT: UP_TO_DATE\nREASON: no\nEXPLANATION_EOF\nup-to-date=true'):
                with self.subTest(kind=kind, raw=raw):
                    result = execute(kind, 'parse', env={'RAW_OUTPUT': raw})
                    self.assertEqual(result['outputs'], {})
                    self.assertEqual(len(result['errors']), 1)
                    self.assertIn('unknown', result['errors'][0])

    def test_readme_does_not_accept_skills_only_irrelevance(self):
        result = execute('readme', 'parse', env={'RAW_OUTPUT': 'VERDICT: IRRELEVANT\nREASON: no'})
        self.assertTrue(result['errors'])

    def test_all_file_pages_include_file_101(self):
        for kind in ('readme', 'skills'):
            result = execute(kind, 'changed-files', total=101,
                             pages=[[{'filename': f'test/{i}'} for i in range(100)], [{'filename': 'src/public-api.ts'}]])
            self.assertEqual(result['errors'], [])
            self.assertTrue(result['outputs']['files'].endswith('src/public-api.ts'))
            self.assertEqual(result['calls'][1][0], 'paginate')

    def test_missing_capped_or_malformed_file_data_is_not_a_verdict(self):
        for kind in ('readme', 'skills'):
            for total, pages in ((101, [[{'filename': 'one'}]]), (3001, [[]]), (None, [[]]),
                                 (-1, [[]]), (1, [[{}]]), (1, [[{'filename': ''}]])):
                with self.subTest(kind=kind, total=total, pages=pages):
                    result = execute(kind, 'changed-files', total=total, pages=pages)
                    self.assertEqual(result['outputs'], {})
                    self.assertTrue(result['errors'])

    def test_api_failures_are_not_empty_success(self):
        for kind in ('readme', 'skills'):
            for failure in ('getError', 'pageError'):
                result = execute(kind, 'changed-files', total=0, pages=[[]], **{failure: True})
                self.assertEqual(result['outputs'], {})
                self.assertTrue(result['errors'])

    def test_confirmed_empty_pr_is_valid_empty_data(self):
        for kind in ('readme', 'skills'):
            result = execute(kind, 'changed-files', total=0, pages=[[]])
            self.assertEqual(result['errors'], [])
            self.assertEqual(result['outputs'], {'files': ''})

    def test_wrappers_keep_known_result_only_comment_conditions(self):
        for kind, positive in (('readme', "steps.check.outputs.up-to-date == 'true'"),
                               ('skills', "steps.check.outputs.needs-update == 'false'")):
            workflow = yaml.load((ROOT / f'.github/workflows/check-{kind}.yaml').read_text(), Loader=yaml.BaseLoader)
            removal = next(step for step in workflow['jobs'][f'check-{kind}']['steps'] if step.get('name', '').startswith('Remove stale'))
            self.assertEqual(removal['if'], positive)
            self.assertNotIn('always()', removal['if'])


if __name__ == '__main__':
    unittest.main()
