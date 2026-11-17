"""Live sync between tabs, offline editing, manual sync mode, conflicts."""


def run(t):
    s = t.start()
    V = s.vault
    a = t.page(ignore=("ERR_FAILED", "Failed to load resource"))
    a.goto(s.url + "/#/Welcome.md"); a.wait_for_timeout(1200)
    b = a.context.new_page()
    b.goto(s.url + "/#/Welcome.md"); b.wait_for_timeout(1500)
    a.click("#ta"); a.keyboard.press("Control+End"); a.keyboard.type(" LIVE-EDIT"); a.wait_for_timeout(2500)
    t.ok("LIVE-EDIT" in b.input_value("#ta"), "live: the other tab updates without a reload")
    b.close()

    # offline: edit, create and rename, then reconnect
    a.context.route("**/api/**", lambda r: r.abort())
    a.keyboard.type(" OFFLINE-EDIT"); a.wait_for_timeout(1500)
    label = a.inner_text("#stSync")
    a.keyboard.press("Alt+n"); a.wait_for_timeout(600); a.keyboard.type("Made offline"); a.keyboard.press("Enter")
    a.keyboard.type("hello from offline"); a.wait_for_timeout(1200)
    t.ok("Offline" in label, f"offline is shown ({label})")
    a.context.unroute("**/api/**")
    a.wait_for_timeout(9000)
    t.ok("OFFLINE-EDIT" in (V / "Welcome.md").read_text() and "hello from offline" in (V / "Made offline.md").read_text(), "offline edits, a new note and its rename all sync on reconnect")

    # conflict: the file changes behind the editor's back
    with open(V / "Welcome.md", "a") as f:
        f.write("\nchanged elsewhere")
    a.keyboard.press("Control+o"); a.keyboard.type("Welcome"); a.keyboard.press("Enter"); a.wait_for_timeout(300)
    a.evaluate("document.getElementById('ta').focus()")
    a.keyboard.press("Control+End"); a.keyboard.type(" mine"); a.wait_for_timeout(1500)
    if "Conflict" in a.inner_text("#stSync"):
        a.click("#stSync"); a.click("text=Keep both"); a.wait_for_timeout(800)
        t.ok((V / "Welcome (my copy).md").exists(), "a conflict can keep both versions")
    else:
        t.ok("changed elsewhere" in a.input_value("#ta"), "an outside change reached the editor before it conflicted")

    # manual mode keeps edits here until Sync
    a.evaluate("document.querySelector('#settingsBtn').click()"); a.wait_for_timeout(500)
    a.click('.prefs-nav [data-cat="sync"]'); a.wait_for_timeout(500)
    a.click('[data-seg="syncMode"] [data-v="manual"]'); a.wait_for_timeout(300)
    a.keyboard.press("Escape"); a.wait_for_timeout(200)
    a.click("#ta"); a.keyboard.press("Control+End"); a.keyboard.type(" MANUAL"); a.wait_for_timeout(2000)
    before = "MANUAL" in (V / "Welcome.md").read_text()
    a.click("#stSync"); a.wait_for_timeout(1500)
    t.ok(not before and "MANUAL" in (V / "Welcome.md").read_text(), "manual sync holds edits until Sync is pressed")
