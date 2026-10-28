import subprocess


def commit_fixture(root, message):
    def git(*args, **options):
        return subprocess.run(['git', '-C', str(root), *args], text=True,
                              capture_output=True, **options)

    git('add', '.', check=True)
    tree = git('write-tree', check=True).stdout.strip()
    parent = git('rev-parse', '--verify', 'HEAD')
    parents = f'parent {parent.stdout.strip()}\n' if parent.returncode == 0 else ''
    count = int(git('rev-list', '--count', 'HEAD', check=True).stdout) if parents else 0
    identity = f'Buildspace test fixture <fixture@example.invalid> {1700000000 + count} +0000'
    content = f'tree {tree}\n{parents}author {identity}\ncommitter {identity}\n\n{message}\n'
    commit = git('hash-object', '-t', 'commit', '-w', '--stdin', input=content, check=True).stdout.strip()
    git('update-ref', 'HEAD', commit, check=True)
    return commit
