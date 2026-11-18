"""Server API: notes, conflicts, safety, history, trash, links, metadata, tokens, search, import."""

import io
import zipfile


def run(t):
    s = t.start()
    api = s.api
    V = s.vault

    # notes and conflicts
    n = api("POST", "/api/note", {"folder": "Work", "name": "Plan", "content": "first"})
    t.ok(n["path"] == "Work/Plan.md" and (V / "Work/Plan.md").read_text() == "first", "create a note in a new folder")
    r = api("PUT", "/api/note?path=Work/Plan.md", {"content": "second", "base": n["version"]})
    t.ok(r["path"] == "Work/Plan.md" and (V / "Work/Plan.md").read_text() == "second", "save with the right base version")
    stale = api("PUT", "/api/note?path=Work/Plan.md", {"content": "third", "base": n["version"]})
    t.ok(stale["_status"] == 409 and stale["content"] == "second", "a stale save is refused as a conflict")

    # path safety
    t.ok(api("GET", "/api/note?path=../server.py")["_status"] == 400, "notes outside the vault are refused")
    t.ok(s.status("GET", "/static/../server.py") == 404, "static files can't escape the static folder")
    t.ok(api("POST", "/api/note", {"name": "x"}, headers={"X-Polarboard": ""}).get("_status") == 403, "writes without the X-Polarboard header are refused")

    # rename relinks, history, trash
    api("POST", "/api/note", {"name": "Index", "content": "See [[Plan]] and [p](Work/Plan.md)"})
    m = api("POST", "/api/move", {"from": "Work/Plan.md", "to": "Work/Roadmap.md", "relink": True})
    t.ok(m["relinked"] == 1 and (V / "Index.md").read_text() == "See [[Roadmap]] and [p](Work/Roadmap.md)", "renaming rewrites links to the note")
    versions = api("GET", "/api/history?path=Index.md")["versions"]
    t.ok(len(versions) == 1, "relinking kept the previous version in history")
    api("POST", "/api/history/restore", {"path": "Index.md", "id": versions[0]["id"]})
    t.ok("[[Plan]]" in (V / "Index.md").read_text(), "restore an old version")
    api("DELETE", "/api/note?path=Index.md")
    items = api("GET", "/api/trash")["items"]
    t.ok(items and items[0]["from"] == "Index.md" and not (V / "Index.md").exists(), "deleting moves to the trash")
    api("POST", "/api/trash/restore", {"id": items[0]["id"]})
    t.ok((V / "Index.md").exists(), "restore from the trash")

    # metadata: tags inherit, pin, sort, folder note
    api("POST", "/api/meta", {"path": "Work", "set": {"tags": ["#Project X"], "sort": "modified", "note": "Work/Roadmap.md"}})
    api("POST", "/api/meta", {"path": "Index.md", "set": {"pinned": True, "tags": ["mine"]}})
    tree = api("GET", "/api/tree")
    notes = {n["path"]: n for n in tree["notes"]}
    t.ok("Project-X" in notes["Work/Roadmap.md"]["tags"] and notes["Index.md"]["pinned"] and "mine" in notes["Index.md"]["tags"], "folder tags inherit, notes pin and tag")
    t.ok(tree["folderMeta"]["Work"] == {"tags": ["Project-X"], "sort": "modified", "note": "Work/Roadmap.md"}, "folder sort and folder note saved")
    api("POST", "/api/meta", {"path": "Work", "set": {"color": "teal"}})
    api("POST", "/api/meta", {"path": "Index.md", "set": {"color": "chartreuse"}})
    tree = api("GET", "/api/tree")
    t.ok(tree["folderMeta"]["Work"]["color"] == "teal" and not next(n for n in tree["notes"] if n["path"] == "Index.md")["color"],
         "folders and notes take a color from the palette, and nothing else")
    api("POST", "/api/meta", {"path": "Work", "set": {"color": None}})
    api("POST", "/api/move", {"from": "Work", "to": "Projects"})
    t.ok(api("GET", "/api/tree")["folderMeta"]["Projects"]["note"] == "Projects/Roadmap.md", "folder note follows a folder rename")

    # append, export
    api("POST", "/api/append", {"path": "Inbox", "text": "- milk"})
    t.ok((V / "Inbox.md").read_text() == "- milk\n", "append creates the note")
    req_zip = zipfile.ZipFile(io.BytesIO(__import__("urllib.request").request.urlopen(s.url + "/api/export").read()))
    names = req_zip.namelist()
    t.ok("Inbox.md" in names and not any("auth.json" in x for x in names), "backup zip has notes and no secrets")

    # tokens
    tok = api("POST", "/api/tokens", {"name": "ci"})["token"]
    t.ok(s.status("GET", "/api/tree", {"Authorization": f"Bearer {tok}"}) == 200, "API token works")
    t.ok(s.status("GET", "/api/tree", {"Authorization": "Bearer pb_nope"}) == 401, "bad token refused")

    # search
    api("POST", "/api/note", {"folder": "Daily", "name": "Monday", "content": "Had oats. Talked roadmap. #food"})
    def found(q):
        return [r["path"] for r in api("GET", "/api/search?q=" + __import__("urllib.parse").parse.quote(q))["results"]]
    t.ok(found("oat") == ["Daily/Monday.md"], "partial words match")
    t.ok(found("roadmap path:projects") == ["Projects/Roadmap.md"], "path: filter")
    t.ok(found("tag:food") == ["Daily/Monday.md"], "tag: filter")
    t.ok("Daily/Monday.md" not in found("roadmap -oats"), "-exclusions")

    # import, including a zip trying to escape the vault
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("Vault/Notes/Hello.md", "# Hello\n![[pic.png]]")
        z.writestr("Vault/img/pic.png", b"PNG")
        z.writestr("Vault/.obsidian/app.json", "{}")
    api("POST", "/api/import?folder=Imported&name=v.zip", raw=buf.getvalue())
    t.ok((V / "Imported/Notes/Hello.md").exists() and not (V / "Imported/.obsidian").exists(), "zip import drops the wrapper folder, keeps folders, skips .obsidian")
    evil = io.BytesIO()
    with zipfile.ZipFile(evil, "w") as z:
        z.writestr("../../escape.md", "x")
        z.writestr("/etc/abs.md", "y")
    api("POST", "/api/import?name=evil.zip", raw=evil.getvalue())
    t.ok(not (s.dir / "escape.md").exists() and not (V.parent / "escape.md").exists() and (V / "escape.md").exists(), "zip entries can't escape the vault")
    att = api("GET", "/api/attachments")
    t.ok(any(f["path"] == "Imported/img/pic.png" and f["used"] for f in att["files"]), "attachment used by name is not flagged")

    # config cleaning
    c = api("PUT", "/api/config", {"attachmentFolder": "../etc"})
    t.ok(c["attachmentFolder"] == "etc", "attachment folder can't point outside the vault")

    # uploads with the same name never overwrite each other
    ups = [api("POST", "/api/upload?name=same.png", raw=f"image {i}".encode(), headers={"Content-Type": "image/png"})["path"] for i in range(3)]
    t.ok(len(set(ups)) == 3 and [(V / u).read_text() for u in ups] == ["image 0", "image 1", "image 2"], "three uploads named alike stay three files")

    # attachments linked as <path with spaces> count as used
    (V / "etc/my photo.png").write_bytes(b"PNG")
    api("POST", "/api/note", {"name": "Album", "content": "![](<etc/my photo.png>)"})
    t.ok(any(f["path"] == "etc/my photo.png" and f["used"] for f in api("GET", "/api/attachments")["files"]), "<angle bracket> image links count as used")

    # share links show the note and its images, never other notes it mentions
    api("POST", "/api/note", {"name": "Secret", "content": "private"})
    api("POST", "/api/note", {"name": "Public", "content": f"See [this](Secret.md) and ![]({ups[0]})"})
    tok = api("POST", "/api/shares", {"path": "Public.md"})["token"]
    t.ok(s.status("GET", f"/api/public/{tok}/file?path={ups[0]}") == 200, "a shared note's image is served")
    t.ok(s.status("GET", f"/api/public/{tok}/file?path=Secret.md") == 404, "a note linked from a shared note is not")

    # wrong passwords are limited per account, whatever IP the client claims
    api("POST", "/api/accounts", {"name": "locked", "password": "correct horse"})
    unlock = lambda pw, ip: api("POST", "/api/accounts/unlock", {"id": "locked", "password": pw}, headers={"X-Forwarded-For": ip}).get("_status")
    codes = [unlock("wrong", f"10.0.0.{i}") for i in range(9)]
    t.ok(codes == [403] * 8 + [429], f"the 9th wrong password waits, even from a new IP ({codes})")
    basic = __import__("base64").b64encode(b"locked:correct horse").decode()
    wrong = __import__("base64").b64encode(b"other:nope").decode()
    api("POST", "/api/accounts", {"name": "other", "password": "right one here"})
    for _ in range(9):
        s.status("GET", "/api/tree?vault=other", {"Authorization": f"Basic {wrong}"})
    t.ok(s.status("GET", "/api/tree?vault=other", {"Authorization": f"Basic {wrong}"}) == 429, "curl -u with a wrong password is limited too")
    t.ok(api("POST", "/api/accounts/unlock", {"id": "other", "password": "right one here"}).get("_status") is None,
         "but a script with an old password can't lock browsers out of signing in")
