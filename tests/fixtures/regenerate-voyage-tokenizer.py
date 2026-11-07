"""Regenerate synthetic canonical IDs; run from repo root with tokenizers==0.22.2.

Does not fetch files or use provider credentials. Keeps the fixture texts unchanged.
Review both IDs and the pinned asset hashes before updating the fixture.
"""
import json
from pathlib import Path

import tokenizers

assert tokenizers.__version__ == "0.22.2"
root = Path(__file__).resolve().parents[2]
fixture_path = root / "tests/fixtures/voyage-tokenizer-golden.json"
fixture = json.loads(fixture_path.read_text())
tokenizer = tokenizers.Tokenizer.from_file(str(root / "assets/tokenizers/voyage-4-large/tokenizer.json"))
tokenizer.no_truncation()
tokenizer.no_padding()
prefix = "Represent the query for retrieving supporting documents: "
for item in fixture["fixtures"]:
    item["ids"] = tokenizer.encode(item["text"]).ids
    item["queryIds"] = tokenizer.encode(prefix + item["text"]).ids
fixture_path.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n")
