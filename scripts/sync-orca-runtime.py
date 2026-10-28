#!/usr/bin/env python3
"""Check, export or pin the separate Orca runtime; never commit or push Git."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('orca_runtime', ROOT / 'codex/hooks/orca_runtime.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--push', action='store_true', help='export complete local runtime to source checkout for review')
    mode.add_argument('--pin-published', action='store_true', help='pin verified source main after matching live files')
    mode.add_argument('--verify-index', action='store_true')
    mode.add_argument('--verify-head', action='store_true')
    parser.add_argument('--repo', type=Path, default=ROOT)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--home', type=Path, default=Path(os.environ.get('ORCA_TEAM_HOME', str(Path.home() / '.orca/roles/ccb-team'))))
    args = parser.parse_args()
    try:
        if args.verify_index or args.verify_head:
            print(json.dumps(runtime.verify_export(args.source, committed=args.verify_head), indent=2))
            return 0
        action = runtime.export if args.push else runtime.pin_published if args.pin_published else runtime.check
        print(json.dumps(action(args.repo, args.home, source=args.source), indent=2))
    except (ValueError, RuntimeError, OSError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
