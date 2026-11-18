"""Writing checks: ignores that last and travel, turning a rule off from its underline, notes that opt out."""

import json


def run(t):
    s = t.start()
    api = s.api

    # the server keeps ignored suggestions beside the dictionary, merging what devices send
    api("PUT", "/api/dictionary", {"add": "Polarbear"})
    r = api("PUT", "/api/dictionary", {"ignore": "123"})
    t.ok(r["words"] == ["Polarbear"] and r["ignored"] == ["123"], "an ignore is saved without touching the dictionary")
    r = api("PUT", "/api/dictionary", {"ignore": ["123", "456", "not a hash"]})
    t.ok(r["ignored"] == ["123", "456"], "a device's unsent ignores are merged in, and only hashes are kept")
    r = api("PUT", "/api/dictionary", {"ignored": []})
    t.ok(r["ignored"] == [] and r["words"] == ["Polarbear"], "clearing them leaves the dictionary alone")

    api("POST", "/api/note", {"name": "Draft", "content": "I met Zorblat at the cafe.\n\nHe go to the store every day."})
    api("POST", "/api/note", {"name": "Spanish", "content": "---\nspellcheck: false\n---\nEl perro come la manzana. Ths is wrng."})
    w = t.page({"spellEngine": "harper"})
    w.goto(s.url + "/#/Draft.md")

    def lint_on(word, present=True):
        for _ in range(25):
            w.wait_for_timeout(400)
            if (w.locator(f'#lints .lint:text-is("{word}")').count() > 0) == present:
                return True
        return False

    def right_click(word):
        box = w.locator(f'#lints .lint:text-is("{word}")').first.bounding_box()
        w.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, button="right"); w.wait_for_timeout(300)

    t.ok(lint_on("Zorblat") and lint_on("go"), "Harper flags a misspelling and a grammar slip")

    # Ignore here: saved on the server, and still ignored after a reload
    right_click("Zorblat"); w.click(".menu >> text=Ignore here"); w.wait_for_timeout(600)
    saved = api("GET", "/api/dictionary")["ignored"]
    t.ok(len(saved) == 1 and saved[0].isdigit(), "an ignore is saved as a hash, not as text")
    w.reload()
    t.ok(lint_on("go") and w.locator('#lints .lint:text-is("Zorblat")').count() == 0, "and it's still ignored after a reload")

    # turn the rule behind a grammar underline off from its menu
    right_click("go")
    item = w.locator(".menu button", has_text="Turn off")
    label = item.inner_text() if item.count() else ""
    t.ok("Pronoun verb agreement" in label, f"the menu names the rule it would turn off ({label!r})")
    if item.count():
        item.click()
    t.ok(lint_on("go", present=False), "turning it off removes the underline")
    rules = json.loads(w.evaluate("localStorage.getItem('pb:settings')"))["harperRules"]
    t.ok(rules.get("PronounVerbAgreement") is False, "and saves it with the individual rules")

    # a note can opt out with spellcheck: false
    w.goto(s.url + "/#/Spanish.md"); w.wait_for_timeout(1500)
    t.ok(w.locator("#lints .lint").count() == 0 and w.inner_text("#stLint") == "Checks off for this note", "spellcheck: false turns checks off for that note")

    # settings: the English-only switch, and showing ignored ones again
    w.click("#settingsBtn"); w.click('[data-cat="editor"]'); w.wait_for_timeout(500)
    body = w.inner_text(".prefs-body")
    t.ok("Skip text that isn’t English" in body and "1 ignored" in body, "Settings → Editor shows the English-only switch and the ignore count")
    w.click('[data-act="clear-ignored"]'); w.wait_for_timeout(600)
    t.ok(api("GET", "/api/dictionary")["ignored"] == [], "Show them again clears the ignores")
