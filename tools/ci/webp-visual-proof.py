#!/usr/bin/env python3
"""Verify the exact WebP case inventory and its pinned illustration derivatives."""

import hashlib
import json
from pathlib import Path
import sys

PROJECTS = {"chromium", "webkit"}
TEST_TITLES = {
    "transparent editable SVG preserves alpha in Standard and Sharp WebP",
    "Cloe line refinement survives SVG reopen and repeatable WebP delivery",
    "Cloe layered contour refinements preserve Fine Sharp WebP detail",
    "Orihime SVG exports a repeatable WebP with the raster master's exact alpha",
    "Cloe's WebP export is repeatable and retains reference detail",
    "Cloe WebP is exported from the full-body editable SVG (--high-detail)",
    "Cloe WebP is exported from the full-body editable SVG (--native-detail)",
    "Hikari reserves editable elements and exports the subgroup without altering alpha",
    "Rei Ai reopens the tablet edit and exports both WebP sizes without altering alpha",
    "Shiori reopens the grimoire edit and exports both WebP sizes without altering alpha",
}
OUTPUTS = {
    "cloe": {
        "directory": "cloe-webp-*-native-detail--{project}",
        "files": {
            "cloe.svg": "1de5a0f410c2cc6b8fc62bf3ba8e49a3439dd12f70c058ecc155bf4b3e437972",
            "from-svg.png": "6220308dcf1b85029d86ae0897bff3298bef2a23043dbf67017c03635f55280b",
            "direct.webp": "bc7bfe191d85376f2297291bd7cbb12f1b465288b36eb5dec7a64c12f2d6d62a",
            "responsive.webp": "c823cedd74c66ddb1b16f5b9dcd8cee16bccb60ad23156c8b96632b3e911cd60",
        },
    },
    "cloe-refinements": {
        "directory": "cloe-webp-Cloe-line-refine-*-{project}",
        "files": {
            "face.svg": "068c34e41d541dee5b1b8cba32c464f1dfd350c4a53eff879d71ef0e70c3804b",
            "face.webp": "de4f27c7ca732204370df774a1e805895dc5e4d61069d1e1e3699b101a24a243",
            "seams.svg": "f6e79d879bad027c8994c800292fdc01e9b361521fb5e7df4e7e113352372879",
            "seams-fine.webp": "259746cc011acf97777c7df59d3442481008d3da1a00455bc3467744e6e0bf47",
            "seams-fine-repeat.webp": "259746cc011acf97777c7df59d3442481008d3da1a00455bc3467744e6e0bf47",
        },
    },
    "cloe-layered-contours": {
        "directory": "cloe-webp-Cloe-layered-con-*-{project}",
        "files": {
            "seams.svg": "f6e79d879bad027c8994c800292fdc01e9b361521fb5e7df4e7e113352372879",
            "seams-fine.webp": "259746cc011acf97777c7df59d3442481008d3da1a00455bc3467744e6e0bf47",
            "hair-satchel.svg": "0e327a82223df961dc38d82690c18a766c6d5c97756d2e46984fd7e43908e86d",
            "hair-satchel-fine.webp": "51db73e95567c2f18365a1d8ca6015ebdb4762f53922d12b4278e828aa19ea17",
            "trouser-shoe.svg": "a993fffeeee7eac44414c6d0f6ff0f4797160bad49d8a6a883163126eed41449",
            "trouser-shoe-fine.webp": "c46802c7b332f6cb3c406646ca9ce8aa084e2cd797dbeb3b75c145dcdc6c896e",
            "stylus.svg": "cb982aa7cfbcf6c5eba74e3056580ce872924e405679ef70763937441bea30e3",
            "stylus-fine.webp": "9e33b828d1c8318a45dc3f35d616d565bb9c2746fb1184560c2566c961a58689",
            "hand.svg": "9cca29481969e8e316d9025d8e2bfb0a14af50da2d40b17e2f8006835723fc03",
            "hand-fine.webp": "55a11407bdfc09fbd8005b9ee7799b2bdac1cc091ea0526e1f2b9fc9cfa50db2",
            "chalkboard.svg": "ac354805a203e7b2675ce076e1084b7a579cc32f403c57e7abc58acab32e7878",
            "chalkboard-fine.webp": "52ccf2182d2844a2b8732aef68813a0252267b2a0c0ac7a8d03a2476a086a65d",
        },
    },
    "orihime": {
        "directory": "cloe-webp-Orihime-*-{project}",
        "files": {
            "orihime.svg": "2eaafe909823c29fb2fb016220cfdbcd30f24767bdfa668472cbafb18d55577a",
            "render.png": "7a687361efc0aeedfe177076122b31b5004207345f584e43d85bce7107f42502",
            "orihime.webp": "ec73cf9bc2edd24cd0c4e4304fd69c96250f03081d8d935c5894dd281f77c57c",
        },
    },
    "hikari-reserved-needlework": {
        "directory": "cloe-webp-Hikari-reserves-*-{project}",
        "files": {
            "reserved.svg": "af53d0f5af3b2623c43259fde7a56d929dea4eb0580bbb5ccd5c79dcf22f9471",
            "edited.svg": "3b94cadb85e7332d2bb51c9df4a857e6fe26c988b85727572167843a731430ba",
            "restored.svg": "af53d0f5af3b2623c43259fde7a56d929dea4eb0580bbb5ccd5c79dcf22f9471",
            "edited.webp": "99c9c3393754ad140895d55649a6c5950b60e7032082a0b0d5a98d4953ed4e44",
            "repeat.webp": "99c9c3393754ad140895d55649a6c5950b60e7032082a0b0d5a98d4953ed4e44",
        },
    },
    "rei-ai-tablet": {
        "directory": "cloe-webp-Rei-Ai-reopens-*-{project}",
        "files": {
            "reserved.svg": "064d718878937055f25a41d51d6dfd8fc6d33b26f7e7e7bbb433acd61a636309",
            "edited.svg": "e257463553896bb04d0afefc617c6326fb7c38a72e33e0ec523f019e5ba5333d",
            "reopened.svg": "e257463553896bb04d0afefc617c6326fb7c38a72e33e0ec523f019e5ba5333d",
            "restored.svg": "064d718878937055f25a41d51d6dfd8fc6d33b26f7e7e7bbb433acd61a636309",
            "edited.webp": "e1e98ee6804c439b50949002893719429631f8e0c10f5da4d6850631a2d15afb",
            "repeat.webp": "e1e98ee6804c439b50949002893719429631f8e0c10f5da4d6850631a2d15afb",
            "full.webp": "1d03f3f22d922708b24f64651515fb28ec95e58eae4026598ab626de3defbde7",
            "repeat-full.webp": "1d03f3f22d922708b24f64651515fb28ec95e58eae4026598ab626de3defbde7",
        },
    },
    "shiori-grimoire": {
        "directory": "cloe-webp-Shiori-reopens-*-{project}",
        "files": {
            "reserved.svg": "6abe9a3f8fb12983c3b59bbd79109d4dc2212fb154f2a5889166a8ca18325bc7",
            "edited.svg": "b592cd7412f07e544dd9351c89a42956aec8c62f02faa5e6bba7e5d0f74f84c8",
            "reopened.svg": "b592cd7412f07e544dd9351c89a42956aec8c62f02faa5e6bba7e5d0f74f84c8",
            "restored.svg": "6abe9a3f8fb12983c3b59bbd79109d4dc2212fb154f2a5889166a8ca18325bc7",
            "edited.webp": "e094a346963e8cd9b745adb062a4e790be1a488c251dced43686abad80fe9e56",
            "repeat.webp": "e094a346963e8cd9b745adb062a4e790be1a488c251dced43686abad80fe9e56",
            "full.webp": "b0b7432edb1fa38d372b032a6deb9043a7acecc4886a79ca512d5eb7a237818b",
            "repeat-full.webp": "b0b7432edb1fa38d372b032a6deb9043a7acecc4886a79ca512d5eb7a237818b"
        }
    },
}
MAX_BYTES = {".svg": 16_000_000, ".png": 32 * 1024 * 1024, ".webp": 500_000}


def read_regular(path, limit):
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= limit:
        raise ValueError("WebP qualification file is absent, linked, or outside its byte bound.")
    return path.read_bytes()


def tests_from(suites):
    for suite in suites:
        for spec in suite.get("specs", []):
            for test in spec["tests"]:
                yield spec, test
        yield from tests_from(suite.get("suites", []))


def verify(result):
    report = json.loads(read_regular(result / "report.json", 4 * 1024 * 1024))
    stats = report["stats"]
    wanted = {(project, title) for project in PROJECTS for title in TEST_TITLES}
    if any(type(stats.get(key)) is not int or stats[key] != expected
           for key, expected in {"expected": len(wanted), "unexpected": 0, "flaky": 0, "skipped": 0}.items()):
        raise ValueError("The WebP suite must pass each required case in its first attempt.")
    tests = list(tests_from(report["suites"]))
    observed = {(row["projectName"], spec["title"]) for spec, row in tests}
    if len(tests) != len(wanted) or observed != wanted or any(
        spec["file"] != "cloe-webp.spec.ts" or row["status"] != "expected"
        or len(row["results"]) != 1 or row["results"][0]["status"] != "passed"
        or type(row["results"][0].get("retry")) is not int or row["results"][0]["retry"] != 0
        for spec, row in tests
    ):
        raise ValueError("Each supported browser must execute and pass its exact case inventory.")
    fixtures = result / "fixtures"
    if fixtures.is_symlink() or not fixtures.is_dir():
        raise ValueError("The WebP suite has no confined fixture output directory.")
    cases = {}
    for project in sorted(PROJECTS):
        cases[project] = {}
        for subject, fixture in OUTPUTS.items():
            matches = list(fixtures.glob(fixture["directory"].format(project=project)))
            if len(matches) != 1 or matches[0].is_symlink() or not matches[0].is_dir():
                raise ValueError("Expected one native-detail output directory for each browser and subject.")
            records = {}
            for filename, expected in fixture["files"].items():
                path = matches[0] / filename
                data = read_regular(path, MAX_BYTES[path.suffix])
                digest = hashlib.sha256(data).hexdigest()
                if digest != expected:
                    raise ValueError(f"{project} {subject} output drifted at {filename}.")
                records[filename] = {"sha256": digest, "size": len(data)}
            cases[project][subject] = records
    return {"schema": "tfsb.ci-native-webp-proof.v1", "status": "pass", "executed": len(wanted), "outputs": cases}


if __name__ == "__main__":
    try:
        proof = verify(Path(sys.argv[1]))
        with Path(sys.argv[2]).open("x") as output:
            json.dump(proof, output, sort_keys=True, indent=2)
            output.write("\n")
    except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
        raise SystemExit(str(error)) from None
