"""Exercise the publisher's shell boundaries without AWS/GitHub credentials."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import yaml

WORKFLOW = yaml.load(Path('.github/workflows/publish-image.yml').read_text(), Loader=yaml.BaseLoader)
STEPS = WORKFLOW['jobs']['publish']['steps']
SHA = 'a' * 40
DIGEST = 'sha256:' + 'b' * 64
SIGNER = 'photon-hq/buildspace/.github/workflows/publish-image.yml'


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.env = dict(os.environ, PATH=f'{self.root}:{os.environ["PATH"]}',
                        RUNNER_TEMP=str(self.root), GITHUB_OUTPUT=str(self.root / 'output'),
                        GITHUB_SHA=SHA, GITHUB_REF='refs/heads/main',
                        GITHUB_REPOSITORY='example/source', IMAGE='worker',
                        IMAGE_TAG=f'main-{SHA}', REGISTRY='registry.example.com',
                        LEGACY_SIGNER='', TEST_SIGNER=SIGNER, TEST_AWS='existing')
        self.stub('aws', '''#!/bin/sh
if [ "$TEST_AWS" = existing ]; then
  printf '%s\\n' '{"imageDetails":[{"imageDigest":"DIGEST"}]}'
else
  echo "$TEST_AWS" >&2; exit 1
fi
'''.replace('DIGEST', DIGEST))
        self.stub('gh', '''#!/usr/bin/env python3
import os,sys
a=sys.argv[1:]
assert a[:2] == ['attestation','verify']
assert a[2] == 'oci://registry.example.com/worker@DIGEST'
for flag,expected in [('--repo','example/source'),('--source-digest',os.environ['GITHUB_SHA']),('--source-ref',os.environ['GITHUB_REF'])]:
    assert a[a.index(flag)+1] == expected
sys.exit(0 if a[a.index('--signer-workflow')+1] == os.environ['TEST_SIGNER'] else 1)
'''.replace('DIGEST', DIGEST))

    def stub(self, name, body):
        p = self.root / name
        p.write_text(body)
        p.chmod(0o755)

    def run_step(self, step, **env):
        return subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', step['run']],
                              env={**self.env, **env}, capture_output=True, text=True)

    def test_tag_must_match_event_commit_and_hotfix_baseline(self):
        step = STEPS[0]
        self.assertEqual(self.run_step(step).returncode, 0)
        for tag in ['main', f'main-{"c" * 40}', f'hotfix-{SHA}-{SHA}']:
            self.assertNotEqual(self.run_step(step, IMAGE_TAG=tag).returncode, 0)
        baseline = 'c' * 40
        self.assertEqual(self.run_step(step, GITHUB_REF=f'refs/heads/hotfix/worker/{baseline}',
                                      IMAGE_TAG=f'hotfix-{baseline}-{SHA}').returncode, 0)
        self.assertNotEqual(self.run_step(step, GITHUB_REF='refs/heads/hotfix/worker/bad').returncode, 0)

    def test_existing_image_requires_original_provenance(self):
        step = next(s for s in STEPS if s.get('id') == 'reuse')
        result = self.run_step(step)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / 'output').read_text(), f'digest={DIGEST}\n')

    def test_legacy_attestation_can_be_reused_without_resigning(self):
        step = next(s for s in STEPS if s.get('id') == 'reuse')
        signer = 'example/source/.github/workflows/docker.yml'
        result = self.run_step(step, TEST_SIGNER=signer, LEGACY_SIGNER=signer)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / 'output').read_text(), f'digest={DIGEST}\n')

    def test_unattested_image_and_registry_errors_fail_closed(self):
        step = next(s for s in STEPS if s.get('id') == 'reuse')
        self.assertNotEqual(self.run_step(step, TEST_SIGNER='untrusted').returncode, 0)
        self.assertNotEqual(self.run_step(step, TEST_AWS='AccessDeniedException').returncode, 0)
        self.assertFalse((self.root / 'output').exists())
        self.assertEqual(self.run_step(step, TEST_AWS='ImageNotFoundException').returncode, 0)

    def test_reuse_skips_build_and_attestation(self):
        for step_id in ['build', 'attest']:
            self.assertEqual(next(s for s in STEPS if s.get('id') == step_id)['if'], "steps.reuse.outputs.digest == ''")
        retry = next(s for s in STEPS if s.get('name', '').startswith('Retry attestation'))
        self.assertEqual(retry['if'], "${{ !cancelled() && steps.build.outcome == 'success' && steps.attest.outcome == 'failure' }}")
        self.assertNotIn('continue-on-error', retry)

    def test_app_token_is_read_only_scoped_and_minted_only_for_a_build(self):
        mint = next(s for s in STEPS if s.get('id') == 'app-token')
        self.assertEqual(mint['if'], "steps.reuse.outputs.digest == '' && inputs.app-token-repositories != ''")
        self.assertEqual(mint['with']['permission-contents'], 'read')
        self.assertEqual(mint['with']['repositories'], '${{ inputs.app-token-repositories }}')
        self.assertEqual([k for k in mint['with'] if k.startswith('permission-')], ['permission-contents'])
        build = next(s for s in STEPS if s.get('id') == 'build')
        self.assertLess(STEPS.index(mint), STEPS.index(build))
        self.assertIn('${{ secrets.build-secrets }}', build['with']['secrets'])
        self.assertIn("format('{0}={1}', inputs.app-token-secret, steps.app-token.outputs.token)", build['with']['secrets'])
        self.assertEqual(WORKFLOW['on']['workflow_call']['inputs']['app-token-repositories']['default'], '')

    def test_prepare_runs_fail_fast_without_the_job_token_and_before_credentials(self):
        step = next(s for s in STEPS if s.get('id') == 'prepare')
        self.assertEqual(step['if'], "inputs.prepare != ''")
        for name in ['GH_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL']:
            self.assertEqual(step['env'][name], '')
        aws = next(i for i, s in enumerate(STEPS) if 'configure-aws-credentials' in s.get('uses', ''))
        checkout = next(i for i, s in enumerate(STEPS) if s.get('uses', '').startswith('actions/checkout'))
        self.assertLess(checkout, STEPS.index(step))
        self.assertLess(STEPS.index(step), aws)
        self.assertEqual(STEPS[checkout]['with']['submodules'], '${{ inputs.submodules }}')
        marker = self.root / 'prepared'
        ok = self.run_step(step, PREPARE=f'true\ntouch {marker}')
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertTrue(marker.exists())
        later = self.root / 'later'
        self.assertNotEqual(self.run_step(step, PREPARE=f'false\ntouch {later}').returncode, 0)
        self.assertFalse(later.exists())

    def test_caller_build_args_cannot_replace_the_event_commit(self):
        args = next(s for s in STEPS if s.get('id') == 'build')['with']['build-args'].split('\n')
        args = [a for a in args if a]
        self.assertEqual(args, ['${{ inputs.build-args }}', 'GIT_SHA=${{ github.sha }}'])

    def test_tag_is_added_last_and_only_to_the_attested_digest(self):
        import hashlib
        import json
        build = next(s for s in STEPS if s.get('id') == 'build')
        self.assertNotIn('tags', build['with'])
        self.assertNotIn('push', build['with'])
        self.assertIn('push-by-digest=true', build['with']['outputs'])
        step = STEPS[-1]
        self.assertEqual(step['id'], 'tag')
        self.assertEqual(step['if'], "steps.reuse.outputs.digest == ''")
        self.assertNotIn('imagetools', step['run'])
        manifest = '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","layers":[]}'
        digest = 'sha256:' + hashlib.sha256(manifest.encode()).hexdigest()
        stored = self.root / 'stored.json'
        stored.write_text(json.dumps({'images': [{'imageManifest': manifest,
                                                   'imageManifestMediaType': 'application/vnd.oci.image.manifest.v1+json'}]}))
        log = self.root / 'aws.log'
        self.stub('aws', '''#!/bin/sh
echo "$@" >> "$TEST_AWS_LOG"
case "$2" in
  batch-get-image) cat "$TEST_STORED" ;;
esac
''')
        env = dict(TEST_STORED=str(stored), TEST_AWS_LOG=str(log))
        ok = self.run_step(step, DIGEST=digest, **env)
        self.assertEqual(ok.returncode, 0, ok.stderr)
        calls = log.read_text()
        self.assertIn(f'imageDigest={digest}', calls)
        self.assertIn(f'ecr put-image --repository-name worker --image-tag main-{SHA} --image-digest {digest}', calls)
        self.assertEqual((self.root / 'built-manifest.json').read_text(), manifest)
        log.write_text('')
        other = self.run_step(step, DIGEST='sha256:' + 'c' * 64, **env)
        self.assertNotEqual(other.returncode, 0)
        self.assertIn('does not hash to the attested', other.stderr)
        self.assertNotIn('put-image', log.read_text())


if __name__ == '__main__':
    unittest.main()
