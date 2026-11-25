#!/usr/bin/env python3
"""Create and check the exact encoder closure identity from Nix path-info JSON."""

import argparse
import json
from pathlib import Path
import re


ROOT = "/nix/store/1zns14x0dv9krcnbznbxkqlj28jxmdcp-imagemagick-7.1.2-31"
STORE_PATH = re.compile(r"/nix/store/[0-9a-df-np-sv-z]{32}-[a-zA-Z0-9+._?=-]+")
NAR_HASH = re.compile(r"sha256-[A-Za-z0-9+/]{43}=")


def normalized_paths(metadata):
    """Select immutable NAR facts shared by remote and installed stores."""
    if not isinstance(metadata, dict) or not 1 <= len(metadata) <= 200 or ROOT not in metadata:
        raise ValueError("Unexpected encoder closure inventory.")
    paths = {}
    for name, entry in metadata.items():
        if STORE_PATH.fullmatch(name) is None or not isinstance(entry, dict):
            raise ValueError("Invalid encoder store path.")
        nar_hash = entry.get("narHash")
        nar_size = entry.get("narSize")
        references = entry.get("references")
        if (not isinstance(nar_hash, str) or NAR_HASH.fullmatch(nar_hash) is None or
                type(nar_size) is not int or nar_size <= 0 or
                not isinstance(references, list) or
                any(not isinstance(ref, str) or ref not in metadata for ref in references) or
                len(set(references)) != len(references)):
            raise ValueError("Invalid encoder NAR metadata.")
        paths[name] = {"narHash": nar_hash, "narSize": nar_size, "references": sorted(references)}

    reached = set()
    pending = [ROOT]
    while pending:
        name = pending.pop()
        if name in reached:
            continue
        reached.add(name)
        pending.extend(paths[name]["references"])
    if reached != paths.keys():
        raise ValueError("Encoder closure contains unrelated paths.")
    return paths


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("create", "check"))
    parser.add_argument("path_info", type=Path)
    parser.add_argument("lock", type=Path)
    arguments = parser.parse_args()
    try:
        metadata = json.loads(arguments.path_info.read_text())
        result = {
            "schemaVersion": 1,
            "cache": "https://cache.nixos.org",
            "system": "x86_64-linux",
            "encoderVersion": "7.1.2-31",
            "root": ROOT,
            "paths": normalized_paths(metadata),
        }
        if arguments.operation == "create":
            with arguments.lock.open("x") as handle:
                json.dump(result, handle, indent=2, sort_keys=True)
                handle.write("\n")
        elif json.loads(arguments.lock.read_text()) != result:
            raise ValueError("Encoder closure differs from the lock.")
    except (OSError, ValueError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
