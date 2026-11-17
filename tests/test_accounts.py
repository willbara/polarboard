"""Accounts are vaults: landing page, passwords, locking, pictures, tokens per account."""

import struct
import zlib


def png():
    def chunk(k, d):
        return struct.pack(">I", len(d)) + k + d + struct.pack(">I", zlib.crc32(k + d) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"\x00\x30\x90\xe0\x30\x90\xe0" * 2)) + chunk(b"IEND", b""))


def run(t):
    s = t.start()
    accounts = s.api("GET", "/api/accounts")["accounts"]
    t.ok(accounts[0]["name"] == "polarboard" and not accounts[0]["locked"] and accounts[0]["icon"]["name"] == "feather", "default account: polarboard, no password, feather picture")

    a = t.page()
    a.goto(s.url + "/")
    a.wait_for_timeout(1500)
    t.ok(not a.is_visible("#landing") and a.locator("#vaultBtn .avatar svg").count() == 1, "one open account opens straight away")

    # profile: name, picture, password
    a.click("#vaultBtn"); a.click(".menu >> text=Account settings…"); a.wait_for_timeout(700)
    a.fill('[data-f="acct-name"]', "Will"); a.click('[data-act="rename"]'); a.wait_for_timeout(400)
    a.click('[data-glyph="mountain"]'); a.wait_for_timeout(300)
    a.click('[data-ahue="160"]'); a.wait_for_timeout(300)
    a.fill('[data-f="password"]', "bearclaw99"); a.fill('[data-f="confirm"]', "bearclaw99"); a.click('[data-act="set-password"]'); a.wait_for_timeout(700)
    t.shot(a, "settings")
    me = s.api("GET", "/api/accounts")["accounts"][0]
    t.ok(me["name"] == "Will" and me["icon"] == {"type": "glyph", "name": "mountain", "hue": 160} and me["locked"], "rename, picture and password saved")
    a.keyboard.press("Escape")

    # a second account
    a.click("#vaultBtn"); a.click(".menu >> text=Add account…"); a.wait_for_timeout(600)
    a.fill("#createName", "Work"); a.click("#createForm button[type=submit]"); a.wait_for_timeout(1800)
    t.ok(a.eval_on_selector("#vaultBtn", "e => e.title") == "Work" and a.locator(".row.note").count() == 0, "a new account starts empty")
    a.evaluate(f"fetch('/api/account/icon', {{method:'POST', headers:{{'X-Polarboard':'1','X-Vault':'work','Content-Type':'image/png'}}, body: new Uint8Array({list(png())})}})")
    a.wait_for_timeout(300)
    a.click("#vaultBtn"); a.click(".menu >> text=Will"); a.wait_for_timeout(1800)
    t.ok(not a.is_visible("#landing") and a.eval_on_selector("#vaultBtn", "e => e.title").startswith("Will"), "this device stays unlocked")

    # another browser
    b = t.page(ignore=("401", "/api/accounts/unlock"))  # locked answers 401; the wrong-password try is 403
    b.goto(s.url + "/"); b.wait_for_timeout(1500)
    names = b.eval_on_selector_all(".account-tile .account-name", "es => es.map(e => e.textContent)")
    t.shot(b, "landing")
    t.ok(b.is_visible("#landing") and names == ["Will", "Work", "Add account"] and b.locator(".account-tile img").count() == 1, "a new browser sees the account picker")
    b.click('[data-account="main"]'); b.fill("#unlockPass", "nope"); b.click("#unlockForm button[type=submit]"); b.wait_for_timeout(900)
    wrong = b.inner_text("#unlockError")
    b.fill("#unlockPass", "bearclaw99"); b.click("#unlockForm button[type=submit]"); b.wait_for_timeout(1800)
    t.ok("isn't right" in wrong and not b.is_visible("#landing"), "wrong password refused, right one opens")
    b.click("#vaultBtn"); b.click(".menu >> text=Lock this account"); b.wait_for_timeout(1200)
    st = b.evaluate("fetch('/api/tree', {headers: {'X-Vault': 'main'}}).then(r => r.status)")
    t.ok(b.is_visible("#landing") and st == 401, "locking closes access")

    # server-level rules
    tok = a.evaluate("fetch('/api/tokens', {method:'POST', headers:{'X-Polarboard':'1','X-Vault':'work','Content-Type':'application/json'}, body:'{\"name\":\"t\"}'}).then(r => r.json())")["token"]
    t.ok(s.status("GET", "/api/tree", {"Authorization": f"Bearer {tok}", "X-Vault": "work"}) == 200
         and s.status("GET", "/api/tree", {"Authorization": f"Bearer {tok}", "X-Vault": "main"}) == 403, "a token only opens its own account")
    import base64
    basic = base64.b64encode(b"main:bearclaw99").decode()
    t.ok(s.status("GET", "/api/tree", {"Authorization": f"Basic {basic}"}) == 200, "curl -u account:password works")
    t.ok(s.api("DELETE", "/api/account", {}, headers={"Authorization": f"Basic {basic}"})["_status"] == 400, "the first account can't be deleted")
