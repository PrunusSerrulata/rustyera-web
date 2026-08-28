#!/usr/bin/env python3
"""Materialize a checksum-verified, task-local test provider without Cargo/network access."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def safe_relative(value):
    path = Path(value)
    if path.is_absolute() or not path.parts or any(part in (".", "..") for part in path.parts):
        raise ValueError(f"unsafe manifest path: {value}")
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    root = Path(__file__).resolve().parent
    source = arguments.source.resolve(strict=True)
    output = arguments.output.resolve()
    if output.exists() or output.is_relative_to(source):
        raise ValueError("output must be a new directory outside the immutable upstream source")
    inventory = json.loads((root / "original-inventory.json").read_text())
    overlay = json.loads((root / "overlay-manifest.json").read_text())
    for row in inventory["files"]:
        path = source / safe_relative(row["path"])
        if path.is_symlink() or not path.is_file() or path.stat().st_size != row["bytes"] or digest(path) != row["sha256"]:
            raise ValueError(f"upstream source mismatch: {row['path']}")
    for row in overlay["files"]:
        path = root / "overrides" / safe_relative(row["path"])
        if path.is_symlink() or not path.is_file() or path.stat().st_size != row["bytes"] or digest(path) != row["sha256"]:
            raise ValueError(f"native overlay mismatch: {row['path']}")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".native-provider-", dir=output.parent))
    try:
        for row in inventory["files"]:
            relative = safe_relative(row["path"])
            target = temporary / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / relative, target)
        for row in overlay["files"]:
            relative = safe_relative(row["path"])
            target = temporary / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / "overrides" / relative, target)
        temporary.rename(output)
    except BaseException:
        shutil.rmtree(temporary)
        raise
    print(json.dumps({"package": inventory["package"], "version": inventory["version"],
                      "upstreamChecksum": inventory["registryChecksum"],
                      "overlaySha256": digest(root / "overlay-manifest.json"),
                      "output": str(output)}))


if __name__ == "__main__":
    main()
