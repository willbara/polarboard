"""The example notes a fresh install starts with: all there, every link working, every note rendering."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXAMPLES = ROOT / "examples"


def run(t):
    s = t.start({"POLARBOARD_EXAMPLES": str(EXAMPLES)})
    api, V = s.api, s.vault

    # a fresh install gets the examples, with their stars, folder page, folder tag and archive
    tree = api("GET", "/api/tree")
    notes = {n["path"]: n for n in tree["notes"]}
    shipped = sorted(p.relative_to(EXAMPLES).as_posix() for p in EXAMPLES.rglob("*.md") if not p.relative_to(EXAMPLES).parts[0].startswith("."))
    t.ok(sorted(notes) == shipped, f"a fresh install starts with the {len(shipped)} example notes")
    t.ok(notes["Welcome.md"]["pinned"] and notes["Welcome.md"]["starred"], "Welcome is pinned and starred")
    t.ok(tree["folderMeta"]["Projects"] == {"note": "Projects/Projects.md", "sort": "modified", "tags": ["project"]}, "Projects has its folder page, sort and tag")
    t.ok("project" in notes["Projects/Reading list.md"]["tags"], "notes in Projects inherit the folder tag")
    t.ok([a["path"] for a in api("GET", "/api/archive")["items"]] == ["Projects/Old website.md"], "the archive holds the old project")
    t.ok((V / "attachments/aurora.svg").exists(), "images come along")
    t.ok("Sintra" in api("GET", "/api/dictionary")["words"], "and the examples' personal dictionary, so the trip note isn't all underlines")

    # every link, embed and image in the examples points at something real
    stems = {Path(p).stem.lower(): p for p in notes} | {p[:-3].lower(): p for p in notes}
    files = {f.split("/")[-1].lower() for f in tree["files"]} | {f.lower() for f in tree["files"]}
    broken = []
    for rel, n in notes.items():
        if rel.startswith("Templates/"):
            continue  # {{yesterday}} and friends are filled in when the template is used
        text = re.sub(r"`[^`\n]*`", "", (V / rel).read_text())  # `[[examples]]` in code aren't links
        for target, heading in re.findall(r"!?\[\[([^\]|#]+)(?:#([^\]|]+))?", text):
            target = target.strip()
            if target == "Someday":  # a link to a note that doesn't exist yet, on purpose
                continue
            if re.search(r"\.(svg|png|jpe?g|gif|webp)$", target, re.I):
                if target.lower() not in files:
                    broken.append(f"{rel}: image {target}")
                continue
            dest = stems.get(target.lower())
            if not dest:
                broken.append(f"{rel}: [[{target}]]")
            elif heading and not re.search(r"^#{1,6}\s+" + re.escape(heading.strip()) + r"\s*$", (V / dest).read_text(), re.M):
                broken.append(f"{rel}: [[{target}#{heading}]]")
        for target in re.findall(r"\]\(([^)\s]+)\)", text):
            if not re.match(r"https?:", target) and target not in notes and target not in tree["files"]:
                broken.append(f"{rel}: ({target})")
    t.ok(not broken, f"every link in the examples works {broken}")

    # every note renders in the browser: code, math, diagrams, embeds and images included
    pg = t.page({"mode": "read"})
    pg.goto(s.url + "/#/Welcome.md"); pg.wait_for_timeout(1000)
    for rel in notes:
        pg.evaluate(f"location.hash = '#/' + {rel!r}.split('/').map(encodeURIComponent).join('/')"); pg.wait_for_timeout(700)
    pg.evaluate("location.hash = '#/Guide/Code%2C%20math%20and%20diagrams.md'"); pg.wait_for_timeout(2500)
    t.ok(pg.locator("#preview pre.mermaid svg").count() == 2 and pg.locator("#preview .katex").count() >= 3 and pg.locator("#preview .hljs-keyword").count() > 0,
         "code, math and both diagrams render")
    pg.evaluate("location.hash = '#/Guide/Links%20and%20embeds.md'"); pg.wait_for_timeout(1500)
    t.ok(pg.locator("#preview .note-embed table").count() == 1, "the embedded section shows its table")
    loaded = pg.eval_on_selector_all("#preview img", "imgs => imgs.map((i) => i.complete && i.naturalWidth > 0)")
    t.ok(len(loaded) == 2 and all(loaded), f"both images load ({loaded})")
