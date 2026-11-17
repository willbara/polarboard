"""Edit in preview, slash menu, tables, properties, embeds, search, export, import, attachments."""

import os
import zipfile


def run(t):
    s = t.start()
    V = s.vault
    s.api("POST", "/api/note", {"name": "Embeds", "content": "Intro.\n\n![[Ideas]]\n\n![[Welcome#Getting around]]\n\nSee ![[Ideas]] inline.\n"})
    s.api("POST", "/api/note", {"name": "Loop", "content": "![[Loop]]\n"})
    pg = t.page()
    pg.goto(s.url + "/#/Welcome.md"); pg.wait_for_timeout(1200)

    # edit inside the preview
    pg.click('[data-mode="read"]'); pg.wait_for_timeout(500)
    pg.click("#preview > h2 >> nth=0"); pg.wait_for_timeout(300)
    src = pg.input_value(".block-ta")
    pg.fill(".block-ta", "## Writing well"); pg.click("#titleView"); pg.wait_for_timeout(1500)
    t.ok(src == "## Writing" and "## Writing well" in (V / "Welcome.md").read_text(), "click a block, edit its markdown, click away to save")
    pg.click("#preview > ul >> nth=0"); pg.keyboard.press("End"); pg.keyboard.type(" EXTRA"); pg.keyboard.press("Escape"); pg.wait_for_timeout(600)
    t.ok("EXTRA" not in (V / "Welcome.md").read_text(), "Esc cancels a block edit")
    pg.evaluate("document.getElementById('previewPane').scrollTop = 1e6"); pg.wait_for_timeout(200)
    pg.mouse.click(840, 780); pg.wait_for_timeout(400)
    if pg.locator(".block-ta").count():
        pg.fill(".block-ta", "A brand new closing paragraph."); pg.keyboard.press("Control+Enter"); pg.wait_for_timeout(1500)
    t.ok((V / "Welcome.md").read_text().rstrip().endswith("A brand new closing paragraph."), "click below the note to add a block")

    # slash menu and tables
    pg.click('[data-mode="write"]'); pg.wait_for_timeout(300)
    pg.click("#ta"); pg.keyboard.press("Control+End"); pg.keyboard.press("Enter"); pg.keyboard.press("Enter")
    pg.keyboard.type("/tab"); pg.wait_for_timeout(250)
    shown = pg.is_visible(".suggest")
    pg.keyboard.press("Enter")
    for cell in ("Fruit", "Count", "Apples", "12"):
        pg.keyboard.type(cell); pg.keyboard.press("Tab")
    pg.wait_for_timeout(1200)
    body = pg.input_value("#ta")
    rows = body[body.index("| Fruit"):].split("\n")[:3] if "| Fruit" in body else []
    t.ok(shown and len(rows) == 3 and len({len(r) for r in rows}) == 1 and "| Apples | 12" in rows[2], f"slash menu table, Tab keeps columns aligned {rows}")

    # properties
    pg.click("#noteMenuBtn"); pg.click(".menu >> text=Add properties"); pg.wait_for_timeout(300)
    pg.keyboard.type("status"); pg.keyboard.press("Enter")
    pg.fill("#props .prop-input >> nth=0", "draft"); pg.keyboard.press("Enter"); pg.wait_for_timeout(300)
    pg.click("#props [data-new]"); pg.keyboard.type("tags"); pg.keyboard.press("Enter")
    pg.select_option("#props .prop-type >> nth=1", "list")
    pg.fill("#props .prop-add-item", "travel"); pg.keyboard.press("Enter"); pg.wait_for_timeout(1500)
    disk = (V / "Welcome.md").read_text()
    t.ok(disk.startswith("---\nstatus: draft\ntags:\n  - travel\n---\n") and not pg.input_value("#ta").startswith("---"), "properties saved as front matter, hidden from the editor")
    pg.reload(); pg.wait_for_timeout(1200)
    t.ok(pg.locator("#props .prop").count() == 2, "properties come back after a reload")

    # embeds
    pg.keyboard.press("Control+o"); pg.keyboard.type("Embeds"); pg.keyboard.press("Enter"); pg.wait_for_timeout(500)
    pg.click('[data-mode="read"]'); pg.wait_for_timeout(1200)
    emb = pg.locator("#preview .note-embed")
    t.ok(emb.count() == 2 and "loose threads" in emb.nth(0).inner_text() and "Ctrl O" in emb.nth(1).inner_text()
         and "Writing well" not in emb.nth(1).inner_text() and pg.locator("#preview a.embed-link").count() == 1, "note and section embeds")
    pg.keyboard.press("Control+o"); pg.keyboard.type("Loop"); pg.keyboard.press("Enter"); pg.wait_for_timeout(1000)
    t.ok("endless loop" in pg.inner_text("#preview"), "a note embedding itself doesn't loop")

    # search panel
    pg.keyboard.press("Control+p"); pg.keyboard.type("loose"); pg.wait_for_timeout(700)
    t.ok(pg.locator("#searchResults mark").count() >= 1, "search highlights matches")
    pg.fill("#searchInput", "tag:travel"); pg.wait_for_timeout(700)
    t.ok(pg.inner_text("#searchResults").startswith("Welcome") and "---" not in pg.inner_text("#searchResults"), "tag: search, without raw front matter")

    # export
    pg.keyboard.press("Control+o"); pg.keyboard.type("Welcome"); pg.keyboard.press("Enter"); pg.wait_for_timeout(600)
    pg.click("#noteMenuBtn"); pg.click(".menu >> text=Export (PDF, HTML, Markdown)…"); pg.click('.export-box [data-fmt="html"]')
    with pg.expect_download() as dl:
        pg.click(".dialog .btn.primary")
    html = open(dl.value.path()).read()
    t.ok("<style>" in html and "Writing well" in html, "HTML export is self-contained")
    pg.evaluate("""() => new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => {
        if (n.tagName === 'IFRAME') n.contentWindow.print = () => { window.__printed = n.contentDocument.documentElement.outerHTML; };
      }))).observe(document.body, { childList: true })""")
    pg.click("#noteMenuBtn"); pg.click(".menu >> text=Export (PDF, HTML, Markdown)…")
    pg.select_option('[data-o="pdfFooter"]', "custom"); pg.fill('[data-o="pdfFooterText"]', "Polarboard · {title}")
    pg.click(".dialog .btn.primary"); pg.wait_for_timeout(2500)
    printed = pg.evaluate("window.__printed") or ""
    t.ok("Polarboard · Welcome" in printed and "counter(page)" in printed, "PDF print page has the footer and page numbers")
    pp = pg.context.new_page(); pp.goto(s.url + "/s/none")
    pp.set_content(printed.replace('href="/static/', f'href="{s.url}/static/'), wait_until="networkidle")
    pdf = pp.pdf(prefer_css_page_size=True, print_background=True)
    t.ok(pdf[:4] == b"%PDF" and len(pdf) > 5000, "the print page renders to a PDF")
    pp.close()

    # import and unused attachments
    zp = s.dir / "import.zip"
    with zipfile.ZipFile(zp, "w") as z:
        z.writestr("Vault/Projects/Plan.md", "# Plan\n![[diagram.png]]\n")
        z.writestr("Vault/Projects/diagram.png", b"PNG")
        z.writestr("Vault/unused.png", b"PNG")
    pg.click("#settingsBtn"); pg.wait_for_timeout(400); pg.click('.prefs-nav [data-cat="files"]'); pg.wait_for_timeout(600)
    pg.select_option('[data-f="import-folder"]', "Imported")
    with pg.expect_file_chooser() as fc:
        pg.click('[data-act="import-zip"]')
    fc.value.set_files(str(zp)); pg.wait_for_timeout(2000)
    t.ok((V / "Imported/Projects/Plan.md").exists(), "import a zip from settings")
    pg.click('.prefs-nav [data-cat="files"]'); pg.wait_for_timeout(500)
    pg.click('[data-act="scan-unused"]'); pg.wait_for_timeout(800)
    names = pg.eval_on_selector_all(".unused-list .item b", "es => es.map(e => e.textContent)")
    pg.click('[data-act="trash-unused"]'); pg.wait_for_timeout(800)
    t.ok(names == ["unused.png"] and not (V / "Imported/unused.png").exists(), "unused attachments found and trashed")
    pg.keyboard.press("Escape")
    pg.keyboard.press("Control+o"); pg.keyboard.type("Plan"); pg.keyboard.press("Enter"); pg.wait_for_timeout(500)
    pg.click('[data-mode="read"]'); pg.wait_for_timeout(700)
    t.ok((pg.get_attribute("#preview img", "src") or "").endswith("Imported/Projects/diagram.png"), "![[name.png]] resolves next to the note")
