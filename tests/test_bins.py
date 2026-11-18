"""Trash and archive in the rail, the read-only reader, and formatting colors."""


def run(t):
    s = t.start()
    api, V = s.api, s.vault

    # archive (server): notes and folders keep their place, tags and history, and come back
    api("POST", "/api/note", {"folder": "Work", "name": "Plan", "content": "the plan [[Other]]"})
    api("POST", "/api/meta", {"path": "Work/Plan.md", "set": {"tags": ["kept"]}})
    tok = api("POST", "/api/shares", {"path": "Work/Plan.md"})["token"]
    r = api("POST", "/api/archive", {"path": "Work/Plan.md"})
    tree = api("GET", "/api/tree")
    t.ok(r["path"] == "Work/Plan.md" and (V / ".archive/Work/Plan.md").exists() and not any(n["path"] == "Work/Plan.md" for n in tree["notes"]),
         "an archived note leaves the notes for .archive/, in the folder it came from")
    listed = api("GET", "/api/archive")["items"]
    t.ok([x["path"] for x in listed] == ["Work/Plan.md"] and listed[0]["archived"], "the archive lists it, with when it went in")
    t.ok(api("GET", "/api/archive/note?path=Work/Plan.md")["content"] == "the plan [[Other]]", "an archived note can be read")
    t.ok(api("PUT", "/api/note?path=.archive/Work/Plan.md", {"content": "x"})["_status"] == 400, "but not written: it is read-only")
    t.ok(not api("GET", "/api/search?q=plan")["results"], "archived notes stay out of search")
    t.ok(s.status("GET", f"/api/public/{tok}") == 404, "its share link pauses while it is archived")
    (V / "attachments").mkdir(exist_ok=True); (V / "attachments/old.png").write_bytes(b"PNG")
    (V / ".archive/Work/Pics.md").write_text("![](attachments/old.png)")
    t.ok(any(f["path"] == "attachments/old.png" and f["used"] for f in api("GET", "/api/attachments")["files"]),
         "an image only an archived note uses is not called unused")
    (V / ".archive/Work/Pics.md").unlink()
    back = api("POST", "/api/archive/restore", {"path": "Work/Plan.md"})
    note = next((n for n in api("GET", "/api/tree")["notes"] if n["path"] == "Work/Plan.md"), {})
    t.ok(back["path"] == "Work/Plan.md" and note.get("ownTags") == ["kept"] and s.status("GET", f"/api/public/{tok}") == 200,
         "unarchiving puts it back with its tags and share link")
    t.ok(not (V / ".archive/Work").exists(), "and leaves no empty folders in the archive")
    api("POST", "/api/note", {"folder": "Old", "name": "A", "content": "a"})
    api("POST", "/api/archive", {"path": "Old"})
    t.ok([x["path"] for x in api("GET", "/api/archive")["items"]] == ["Old/A.md"], "a whole folder can be archived")
    api("DELETE", "/api/archive?path=Old/A.md")
    trash = api("GET", "/api/trash")["items"]
    t.ok(trash and trash[0]["from"] == "Old/A.md" and not api("GET", "/api/archive")["items"], "an archived note can go to the trash")
    t.ok(api("GET", f"/api/trash/note?id={trash[0]['id']}")["content"] == "a", "a trashed note can be read")
    api("POST", "/api/trash/restore", {"id": trash[0]["id"]})
    t.ok((V / "Old/A.md").exists(), "and restoring it puts it back with the notes")

    # trash and archive in the rail
    api("POST", "/api/note", {"name": "Gone", "content": "# Gone\n\n- [ ] still here"})
    api("DELETE", "/api/note?path=Gone.md")
    api("POST", "/api/note", {"name": "Shelved", "content": "## Kept for later"})
    pg = t.page()
    pg.goto(s.url + "/#/Welcome.md"); pg.wait_for_timeout(1000)
    pg.click("#railTrash"); pg.wait_for_timeout(500)
    t.ok(pg.is_visible("#trashList") and pg.locator("#trashList .bin-row b", has_text="Gone").count() == 1 and pg.is_visible("#emptyTrashBtn"),
         "the bin in the rail shows the trash in the sidebar")
    t.ok("active" in pg.get_attribute("#railTrash", "class"), "and is marked as open")
    pg.click("#trashList .bin-row >> text=Gone"); pg.wait_for_timeout(500)
    t.ok(pg.locator(".reader .md h1", has_text="Gone").count() == 1 and "read only" in pg.inner_text(".reader .history-head"), "a deleted note opens in the read-only reader")
    pg.click('.reader [data-act="back"]'); pg.wait_for_timeout(800)
    t.ok((V / "Gone.md").exists() and pg.locator("#trashList .bin-row b", has_text="Gone").count() == 0, "restore from the reader")
    pg.click("#railTrash"); pg.wait_for_timeout(300)
    t.ok(pg.is_visible("#tree") and not pg.is_visible("#trashList"), "clicking the bin again goes back to the notes")

    pg.click('.row.note[data-note="Shelved.md"]', button="right"); pg.click(".menu >> text=Archive"); pg.wait_for_timeout(800)
    t.ok(pg.locator('.row.note[data-note="Shelved.md"]').count() == 0 and (V / ".archive/Shelved.md").exists(), "archive a note from its menu")
    pg.click("#railArchive"); pg.wait_for_timeout(500)
    t.ok(pg.locator("#archiveList .bin-row b", has_text="Shelved").count() == 1, "the box in the rail lists archived notes")
    pg.click("#archiveList .bin-row >> text=Shelved"); pg.wait_for_timeout(500)
    t.ok(pg.locator(".reader .md h2", has_text="Kept for later").count() == 1 and pg.locator(".reader textarea, .reader [contenteditable]").count() == 0,
         "an archived note opens read-only")
    pg.click('.reader [data-act="back"]'); pg.wait_for_timeout(800)
    t.ok((V / "Shelved.md").exists() and pg.locator('.row.note[data-note="Shelved.md"]').count() == 1, "unarchive it from the reader")

    # formatting colors: accent shades by default, a picked color, or off
    pg.click("#railArchive"); pg.wait_for_timeout(200)  # back to the notes
    pg.click(".row.note[data-note='Shelved.md']"); pg.wait_for_timeout(600)
    color = lambda sel: pg.eval_on_selector(sel, "e => getComputedStyle(e).color")
    h2 = color("#hl .t-h2")
    t.ok(h2 not in ("rgb(242, 242, 242)", "rgb(212, 212, 212)"), f"headings are tinted with the accent by default ({h2})")
    pg.evaluate("""() => { const s = JSON.parse(localStorage.getItem('pb:settings')); s.fmt = { h2: '#ff0000' }; localStorage.setItem('pb:settings', JSON.stringify(s)); }""")
    pg.reload(); pg.wait_for_timeout(900)
    t.ok(color("#hl .t-h2") == "rgb(255, 0, 0)", "a picked color is used")
    pg.click("#settingsBtn"); pg.click('[data-cat="appearance"]'); pg.wait_for_timeout(300)
    t.ok(pg.locator(".fmt-pick").count() == 13 and pg.locator('[data-fmt-reset="h2"]').count() == 1, "Appearance lists every format, and which one is custom")
    pg.click('[data-fmt-reset="h2"]'); pg.wait_for_timeout(200)
    t.ok(color("#hl .t-h2") == h2, "reset goes back to the accent shade")
    pg.click('.pref:has-text("Color formatting") [data-toggle]'); pg.wait_for_timeout(200)
    t.ok(color("#hl .t-h2") == "rgb(242, 242, 242)" and pg.locator(".fmt-pick").count() == 0, "turned off, headings are plain again")
