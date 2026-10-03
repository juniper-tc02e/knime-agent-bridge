"""Package this beta's source and selected bridge JAR, never its runtime data."""
import hashlib
import json
from pathlib import Path
import re
import zipfile

root = Path(__file__).resolve().parent.parent
metadata = json.loads((root / "package.json").read_text(encoding="utf-8"))
latest = json.loads((root / "artifacts/latest.json").read_text(encoding="utf-8"))
bundle = latest["bundle"]
if not re.fullmatch(r"org\.knime\.agent\.bridge_" + re.escape(metadata["version"]) + r"-[0-9a-f]{12}\.jar", bundle):
    raise ValueError("Build a versioned bridge bundle before packaging.")

files = [root / name for name in [
    "README.md", "AGENTS.md", ".gitignore", "Launch KNIME Agent.cmd",
    "package.json", "package-lock.json", "artifacts/latest.json",
    "artifacts/" + bundle,
]]
for directory in ["docs", "java", "src", "scripts", "tests"]:
    files.extend(p for p in (root / directory).rglob("*") if p.is_file() and "__pycache__" not in p.parts)
payload = {}
for file in sorted(set(files)):
    if file.is_symlink() or not file.resolve().is_relative_to(root):
        raise ValueError("Refusing external/symlink package input: " + str(file))
    payload[file.relative_to(root).as_posix()] = file.read_bytes()

digest = lambda data: hashlib.sha256(data).hexdigest()
manifest = {name: digest(data) for name, data in payload.items()}
payload["SHA256SUMS.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
prefix = "knime-agent-bridge/"
output = root / "artifacts" / ("knime-agent-bridge-" + metadata["version"] + ".zip")
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for name, data in payload.items():
        entry = zipfile.ZipInfo(prefix + name, date_time=(2026, 9, 28, 0, 0, 0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(entry, data)
with zipfile.ZipFile(output) as archive:
    if archive.testzip() is not None:
        raise ValueError("Archive CRC verification failed.")
    if set(archive.namelist()) != {prefix + name for name in payload}:
        raise ValueError("Unexpected archive contents.")
    for name, expected in manifest.items():
        if digest(archive.read(prefix + name)) != expected:
            raise ValueError("Archive hash verification failed: " + name)
checksum = digest(output.read_bytes())
output.with_suffix(".zip.sha256").write_text(checksum + "  " + output.name + "\n", encoding="utf-8")
print(json.dumps({"archive": str(output), "files": len(payload), "bytes": output.stat().st_size,
                  "sha256": checksum, "bundle": bundle, "bundleSha256": manifest["artifacts/" + bundle],
                  "verified": True}, indent=2))
