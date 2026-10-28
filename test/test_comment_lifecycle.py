import json
from pathlib import Path
import subprocess
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = yaml.load((ROOT / '.github/blocks/comment-on-pr/action.yaml').read_text(), Loader=yaml.BaseLoader)['runs']['steps'][0]['with']['script']
RUNNER = r'''
const fs = require('node:fs');
const data = JSON.parse(fs.readFileSync(0, 'utf8'));
Object.assign(process.env, data.env || {});
const calls = [], errors = [];
const issues = Object.fromEntries(['listComments', 'createComment', 'updateComment', 'deleteComment'].map(name => [name, async options => {
  calls.push([name, options]);
  if (data.writeError) throw new Error('write failed');
}]));
const github = {rest: {issues}, paginate: async (method, options) => {
  calls.push(['paginate', options]);
  if (method !== issues.listComments) throw new Error('unexpected method');
  if (data.readError) throw new Error('read failed');
  return (data.pages || []).flat();
}};
const core = {warning: message => calls.push(['warning', message])};
const context = {repo: {owner: 'fixture', repo: 'caller'}, payload: data.noPr ? {} : {pull_request: {number: 7}}};
console.log = () => {};
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
(async () => {
  try {await new AsyncFunction('github', 'context', 'core', data.script)(github, context, core);}
  catch (error) {errors.push(error.message);}
  process.stdout.write(JSON.stringify({calls, errors}));
})();
'''


def execute(state='present', key='check-readme', **values):
    result = subprocess.run(['node', '-e', RUNNER], input=json.dumps({'script': SCRIPT,
                            'env': {'COMMENT_STATE': state, 'COMMENT_KEY': key, 'COMMENT_MESSAGE': 'body'}, **values}),
                            capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


class CommentTests(unittest.TestCase):
    def test_create_update_and_unkeyed_default(self):
        self.assertEqual(execute()['calls'][-1][0], 'createComment')
        result = execute(pages=[[{'id': 9, 'body': '<!-- comment-key: check-readme -->\nold'}]])
        self.assertEqual(result['calls'][-1][0], 'updateComment')
        self.assertEqual(result['calls'][-1][1]['comment_id'], 9)
        self.assertEqual([c[0] for c in execute(key='')['calls']], ['createComment'])

    def test_paginated_delete_preserves_other_markers_and_first_duplicate_policy(self):
        pages = [[{'id': i, 'body': 'unrelated'} for i in range(100)],
                 [{'id': 101, 'body': '<!-- comment-key: check-skills -->'},
                  {'id': 102, 'body': '<!-- comment-key: check-readme -->'},
                  {'id': 103, 'body': '<!-- comment-key: check-readme -->'}]]
        result = execute(state='absent', pages=pages)
        self.assertEqual(result['errors'], [])
        self.assertEqual(result['calls'][-1], ['deleteComment', {'owner': 'fixture', 'repo': 'caller', 'comment_id': 102}])
        self.assertEqual(len([c for c in result['calls'] if c[0] == 'deleteComment']), 1)

    def test_marker_safety_and_invalid_state_prevent_writes(self):
        for key in ('', '   ', 'x\ny', 'x -->'):
            result = execute(state='absent', key=key)
            self.assertTrue(result['errors'])
            self.assertEqual(result['calls'], [])
        self.assertTrue(execute(state='gone')['errors'])

    def test_update_and_create_search_every_comment_page(self):
        first = [{'id': i, 'body': 'unrelated'} for i in range(100)]
        result = execute(pages=[first, [{'id': 101, 'body': '<!-- comment-key: check-readme -->'}]])
        self.assertEqual(result['errors'], [])
        self.assertEqual(result['calls'][-1][0], 'updateComment')
        self.assertEqual(result['calls'][-1][1]['comment_id'], 101)
        result = execute(pages=[first, [{'id': 101, 'body': '<!-- comment-key: another-check -->'}]])
        self.assertEqual(result['errors'], [])
        self.assertEqual(result['calls'][-1][0], 'createComment')

    def test_absent_match_and_no_pr_are_no_write(self):
        self.assertEqual([c[0] for c in execute(state='absent')['calls']], ['paginate'])
        for state in ('present', 'absent'):
            self.assertEqual([c[0] for c in execute(state=state, noPr=True)['calls']], ['warning'])

    def test_no_pr_keeps_the_existing_skip_before_input_validation(self):
        for state, key in (('present', 'invalid\nmarker'), ('absent', ''), ('unknown', 'marker')):
            result = execute(state=state, key=key, noPr=True)
            self.assertEqual(result['errors'], [])
            self.assertEqual([call[0] for call in result['calls']], ['warning'])

    def test_api_errors_propagate_without_fallback(self):
        result = execute(state='absent', readError=True)
        self.assertEqual([c[0] for c in result['calls']], ['paginate'])
        self.assertTrue(result['errors'])
        self.assertTrue(execute(writeError=True)['errors'])


if __name__ == '__main__':
    unittest.main()
