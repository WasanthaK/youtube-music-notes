from __future__ import annotations

import argparse
import json
import shutil
import urllib.request
import zipfile
from pathlib import Path


ZENODO_API = 'https://zenodo.org/api/records/3371780'
WANTED = {'annotation.zip', 'audio_mono-mic.zip'}


def download(url: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.stat().st_size > 0:
        print(f'using existing {target}')
        return
    print(f'downloading {target.name}...')
    with urllib.request.urlopen(url) as response, target.open('wb') as handle:
        shutil.copyfileobj(response, handle)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--dest', default='data/GuitarSet')
    parser.add_argument('--keep-zips', action='store_true')
    args = parser.parse_args()

    dest = Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)

    with urllib.request.urlopen(ZENODO_API) as response:
        record = json.load(response)

    files = {entry['key']: entry for entry in record.get('files', [])}
    missing = WANTED - files.keys()
    if missing:
        raise RuntimeError(f'Zenodo record missing expected files: {sorted(missing)}')

    for name in sorted(WANTED):
        entry = files[name]
        url = entry['links']['self']
        zip_path = dest / name
        download(url, zip_path)
        print(f'extracting {name}...')
        with zipfile.ZipFile(zip_path) as archive:
            archive.extractall(dest)
        if not args.keep_zips:
            zip_path.unlink(missing_ok=True)

    print(f'GuitarSet training material ready under {dest.resolve()}')


if __name__ == '__main__':
    main()
