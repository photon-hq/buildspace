from pathlib import Path
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = yaml.load((ROOT / '.github/workflows/typescript-service-release.yaml').read_text(), Loader=yaml.BaseLoader)


class LegacyNotifyTests(unittest.TestCase):
    def test_only_the_obsolete_notification_contract_is_absent(self):
        call = WORKFLOW['on']['workflow_call']
        self.assertNotIn('notify-on-release', call['inputs'])
        self.assertNotIn('TS_OAUTH_CLIENT_ID', call['secrets'])
        self.assertNotIn('TS_OAUTH_SECRET', call['secrets'])
        self.assertNotIn('notify', WORKFLOW['jobs'])
        self.assertTrue({'OPENAI_API_KEY', 'NPM_TOKEN', 'APP_ID', 'APP_PRIVATE_KEY'}.issubset(call['secrets']))

    def test_release_jobs_outputs_and_concurrency_are_retained(self):
        self.assertTrue({
            'check-labels', 'release-info', 'bump-version', 'github-release', 'npm-publish',
            'npm-publish-oidc', 'github-packages-publish',
        }.issubset(WORKFLOW['jobs']))
        self.assertTrue({'version', 'tag', 'source-sha'}.issubset(WORKFLOW['on']['workflow_call']['outputs']))
        self.assertEqual(WORKFLOW['concurrency'], {
            'group': '${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': 'false',
        })

    def test_explicit_manual_overrides_and_publication_defaults_are_retained(self):
        inputs = WORKFLOW['on']['workflow_call']['inputs']
        for name in ('release', 'prerelease', 'dry-run', 'use-oidc', 'no-npm-publish', 'publish-github-packages'):
            self.assertEqual(inputs[name]['type'], 'boolean')
            self.assertEqual(inputs[name]['default'], 'false')
        release = WORKFLOW['jobs']['release-info']
        self.assertEqual(release['needs'], 'check-labels')
        self.assertEqual(release['if'], 'fromJSON(needs.check-labels.outputs.labels).release || inputs.release')
        self.assertEqual(WORKFLOW['jobs']['check-labels']['permissions'], {
            'pull-requests': 'read', 'contents': 'read',
        })

    def test_xcode_and_makefile_dylib_paths_remain_available(self):
        for path in (
            '.github/workflows/dylib-release.yml', '.github/blocks/build-dylib/action.yml',
            '.github/blocks/install-cocoapods/action.yml', '.github/workflows/makefile-dylib-release.yml',
            '.github/blocks/build-makefile-dylib/action.yml',
        ):
            self.assertTrue((ROOT / path).is_file(), path)


if __name__ == '__main__':
    unittest.main()
