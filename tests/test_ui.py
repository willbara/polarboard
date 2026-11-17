"""Tabs, focus mode, sidebar menus, settings, hotkeys, history, trash, mobile."""


def run(t):
    s = t.start()
    pg = t.page()
    tabs = lambda: pg.eval_on_selector_all("#tabs .tab .label", "es => es.map(e => e.textContent)")
    active = lambda: pg.inner_text("#tabs .tab.active .label")
    pg.goto(s.url + "/#/Welcome.md"); pg.wait_for_timeout(1200)
    t.ok(tabs() == ["Welcome"], "one tab on load")
    pg.click('.row.folder[data-folder="Ideas"]'); pg.wait_for_timeout(200)
    pg.click('.row.note[data-note="Ideas/Ideas.md"]', modifiers=["Control"]); pg.wait_for_timeout(500)
    t.ok(tabs() == ["Welcome", "Ideas"] and active() == "Ideas", "Ctrl+click opens a new tab")
    pg.click('.row.note[data-note="Welcome.md"]'); pg.wait_for_timeout(400)
    t.ok(active() == "Welcome" and len(tabs()) == 2, "an open note switches to its tab")
    pg.click("#ta"); pg.keyboard.press("Control+End"); pg.keyboard.type(" x")
    dirty = pg.eval_on_selector("#tabs .tab.active", "e => e.classList.contains('dirty')")
    pg.wait_for_timeout(1500)
    t.ok(dirty and not pg.eval_on_selector("#tabs .tab.active", "e => e.classList.contains('dirty')"), "unsaved dot clears after saving")
    pg.reload(); pg.wait_for_timeout(1000)
    t.ok(tabs() == ["Welcome", "Ideas"], "tabs come back after a reload")

    # focus mode
    pg.keyboard.press("Control+Shift+F"); pg.wait_for_timeout(500); pg.mouse.move(640, 400); pg.wait_for_timeout(400)
    op = lambda sel: float(pg.eval_on_selector(sel, "e => getComputedStyle(e).opacity"))
    t.ok(not pg.is_visible(".rail") and op(".tabbar") == 0, "focus mode hides everything")
    pg.mouse.move(900, 40); pg.wait_for_timeout(500)
    t.ok(op(".tabbar") == 1, "pointing at the top brings the bar back")
    pg.mouse.move(640, 400); pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    t.ok(pg.is_visible(".rail"), "Esc leaves focus mode")

    # sidebar menus
    pg.click('.row.note[data-note="Welcome.md"]', button="right"); pg.click(".menu >> text=Tags…"); pg.wait_for_timeout(200)
    pg.keyboard.type("reading"); pg.keyboard.press("Enter"); pg.click(".dialog .btn.primary"); pg.wait_for_timeout(500)
    t.ok("#reading" in pg.inner_text("#noteTags"), "tags from the note menu show under the title")
    pg.click('.row.folder[data-folder="Ideas"]', button="right"); pg.click(".menu >> text=Sort this folder…"); pg.click(".menu >> text=Name (Z to A)"); pg.wait_for_timeout(400)
    t.ok(s.api("GET", "/api/tree")["folderMeta"]["Ideas"]["sort"] == "name-desc", "sort a single folder")
    pg.click('.row.note[data-note="Welcome.md"]', button="right"); pg.click(".menu >> text=Pin to top"); pg.wait_for_timeout(400)
    t.ok(pg.is_visible('.row.note[data-note="Welcome.md"] .pin'), "pin a note")

    # history and trash
    pg.click("#ta"); pg.keyboard.press("Control+End"); pg.keyboard.type("\nnew line"); pg.wait_for_timeout(1500)
    pg.keyboard.press("Alt+h"); pg.wait_for_timeout(700)
    t.ok(pg.locator(".history-list [data-id]").count() >= 1, "version history lists earlier versions")
    pg.keyboard.press("Escape")
    pg.click('.row.note[data-note="Welcome.md"]', button="right"); pg.click(".menu >> text=Duplicate"); pg.wait_for_timeout(700)
    pg.click("#noteMenuBtn"); pg.click(".menu button.danger"); pg.click(".dialog .btn.danger"); pg.wait_for_timeout(600)
    t.ok(not (s.vault / "Welcome copy.md").exists(), "delete goes to the trash")
    pg.click("#settingsBtn"); pg.wait_for_timeout(400)
    for cat in ("general", "appearance", "interface", "editor", "files", "hotkeys", "keychain", "sync"):
        pg.click(f'.prefs-nav [data-cat="{cat}"]'); pg.wait_for_timeout(500)
        t.ok("could not load" not in pg.inner_text(".prefs-body"), f"settings: {cat}")
    pg.click('.prefs-nav [data-cat="sync"]'); pg.wait_for_timeout(500)
    pg.click('.prefs-body [data-act="restore"] >> nth=0'); pg.wait_for_timeout(700)
    t.ok((s.vault / "Welcome copy.md").exists(), "restore from the trash in settings")
    pg.click('.prefs-nav [data-cat="hotkeys"]'); pg.wait_for_timeout(400)
    pg.click('[data-record="focusMode"]'); pg.keyboard.press("Control+Shift+J"); pg.wait_for_timeout(300)
    t.ok(pg.inner_text('[data-record="focusMode"]') == "Ctrl Shift J", "rebind a shortcut")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    pg.keyboard.press("Control+Shift+J"); pg.wait_for_timeout(300)
    t.ok(pg.eval_on_selector("#app", "e => e.classList.contains('focus')"), "the new shortcut works")
    pg.keyboard.press("Escape")

    # mobile
    m = t.page(viewport=(390, 844), mobile=True)
    m.goto(s.url + "/#/Welcome.md"); m.wait_for_timeout(1000)
    m.click("#sidebarBtn"); m.wait_for_timeout(500)
    t.shot(m, "mobile-drawer")
    t.ok(m.eval_on_selector("#app", "e => e.classList.contains('drawer-open')"), "the mobile drawer opens")
