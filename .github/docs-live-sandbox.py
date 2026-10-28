import json
import os
from pathlib import Path
import subprocess
import sys

import yaml


ROOT = Path.cwd()
DOCS = ROOT / 'docs/repo'
RESULTS = ROOT / 'results'
RESULTS.mkdir(exist_ok=True)
ACTION = yaml.load((ROOT / '.github/blocks/update-docs/action.yaml').read_text(), Loader=yaml.BaseLoader)
STEPS = ACTION['runs']['steps']
BASE_ENV = {key: os.environ[key] for key in ('PATH', 'HOME', 'LANG', 'LC_ALL', 'RUNNER_TEMP') if key in os.environ}


def outputs(path):
    result = {}
    lines = iter(path.read_text().splitlines())
    for line in lines:
        if '<<' in line:
            key, delimiter = line.split('<<', 1)
            value = []
            for part in lines:
                if part == delimiter:
                    break
                value.append(part)
            result[key] = '\n'.join(value)
        elif '=' in line:
            key, value = line.split('=', 1)
            result[key] = value
    return result


def run_step(step, cwd, env, output):
    output.write_text('')
    subprocess.run(['bash', '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step['run']], cwd=cwd,
                   env=BASE_ENV | env | {'GITHUB_OUTPUT': str(output)}, check=True)
    return outputs(output)


if sys.argv[1] == 'prepare':
    notes = subprocess.check_output(['gh', 'release', 'view', 'v0.1.0', '--repo', 'photon-hq/voice-ts', '--json', 'body', '--jq', '.body'], text=True)
    collector = yaml.load((ROOT / '.github/blocks/collect-release-context/action.yaml').read_text(), Loader=yaml.BaseLoader)
    context = {}
    for index, step in enumerate(collector['runs']['steps']):
        context.update(run_step(step, ROOT / 'voice', {'RAW_TAG': 'v0.1.0', 'RELEASE_BODY': notes}, RESULTS / f'context-{index}.outputs'))
    written = run_step(next(step for step in STEPS if step.get('id') == 'write-context'), DOCS,
                       {'DOCS_DIR': str(DOCS), 'SERVICE_NAME': 'voice-ts', 'VERSION': context['version'],
                        'RELEASE_NOTES': context['release_notes'], 'CHANGES_DIFF': context['changes_diff']}, RESULTS / 'write-context.outputs')
    prompt = run_step(next(step for step in STEPS if step.get('id') == 'write-prompt'), DOCS,
                      {'DOCS_DIR': str(DOCS), 'DOCS_REPO': 'photon-hq/docs', 'DOCS_PATH': 'voice-ts',
                       'SERVICE_NAME': 'voice-ts', 'VERSION': context['version'], 'CONTEXT_DIR': written['context-dir']}, RESULTS / 'write-prompt.outputs')
    metadata = {'source_tag': 'v0.1.0', 'source_sha': 'a3182d89779d012b1484f8fbbd0e432a4958756a',
                'docs_sha': 'bbfa2b424e60419ee0f0d25f4b4b7325ec2a564f',
                'candidate_sha': '2bdb6d264690f03e7dc9476eb77fad4747c0bf71',
                'action_sha': 'c12e8a97976b679f5e93247b15b03e9a80360a29',
                'model': 'claude-opus-4-6', 'diff_characters': len(context['changes_diff']),
                'context_dir': written['context-dir'], 'prompt_file': prompt['prompt-file']}
    (RESULTS / 'metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
elif sys.argv[1] == 'generate':
    metadata = json.loads((RESULTS / 'metadata.json').read_text())
    step = next(step for step in STEPS if step.get('name') == 'Run Claude Code')
    env = BASE_ENV | {'DOCS_DIR': str(DOCS), 'PROMPT_FILE': metadata['prompt_file'],
                      'ANTHROPIC_API_KEY': os.environ['ANTHROPIC_API_KEY']}
    with (RESULTS / 'claude.stdout.log').open('w') as stdout, (RESULTS / 'claude.stderr.log').open('w') as stderr:
        result = subprocess.run(['bash', '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step['run']],
                                cwd=DOCS, env=env, stdout=stdout, stderr=stderr)
    metadata['claude_exit_code'] = result.returncode
    (RESULTS / 'metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
    run_step(next(step for step in STEPS if step.get('name') == 'Remove context and prompt files'), DOCS,
             {'CONTEXT_DIR': metadata['context_dir'], 'PROMPT_FILE': metadata['prompt_file']}, RESULTS / 'cleanup.outputs')
    raise SystemExit(result.returncode)
elif sys.argv[1] == 'collect':
    subprocess.run(['git', '-C', str(DOCS), 'add', '-N', '.'], check=True)
    for name, args in [('generated.patch', ['diff', '--binary']), ('generated.stat', ['diff', '--stat']), ('generated.status', ['status', '--short'])]:
        (RESULTS / name).write_bytes(subprocess.check_output(['git', '-C', str(DOCS), *args]))
