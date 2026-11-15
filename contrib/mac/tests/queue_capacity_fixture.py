"""Offline GitHub capacity evidence for existing restock behavior fixtures."""
import sys


def install_capacity_gh(directory):
    directory.mkdir(parents=True, exist_ok=True)
    script = directory / 'gh'
    script.write_text('#!' + sys.executable + '\n' + '''import json, sys
args = sys.argv[1:]
if args[:2] == ['pr', 'list']:
    print('[]')
elif 'graphql' in args:
    print(json.dumps({'data': {'repository': {'mergeQueue': {'entries': {'totalCount': 0}}}}}))
else:
    print(json.dumps({'total_count': 100, 'runners': [{'status': 'online', 'busy': False}] * 100}))
''')
    script.chmod(0o755)
