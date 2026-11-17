# Polarboard

Quiet markdown notes on your own server.

Your notes are plain `.md` files in folders. Each account is its own folder of notes (like an Obsidian vault). You can open one in Obsidian, VS Code, or anything else, and back it up or sync it however you like.

## Run it

**Directly** (needs Python 3.10 or newer, nothing to install; `git` is optional):

```sh
python3 server.py
# open http://localhost:8787
```

**With Podman or Docker:**

```sh
podman compose up -d --build     # or: docker compose up -d --build
```

Everything is stored in `./data`, next to `compose.yaml`.

## Configuration

All settings are environment variables:

| Variable | Default | What it does |
| --- | --- | --- |
| `POLARBOARD_DATA` | the app folder | Where accounts, their notes and share links are kept |
| `POLARBOARD_VAULT` | `$POLARBOARD_DATA/vault` | Notes of the first account ("polarboard") |
| `POLARBOARD_PORT` | `8787` | Port to listen on |
| `POLARBOARD_HOST` | `0.0.0.0` | Address to bind |
| `POLARBOARD_PASSWORD` | *(empty)* | A server password, required to create or delete accounts |
| `POLARBOARD_LOG` | *(empty)* | Set to `1` to log every request |
| `POLARBOARD_BACKUPS` | `$POLARBOARD_DATA/backups` | Where scheduled backups are written, one folder per account. Point it at a NAS or a second disk |

## Layout on disk

```
data/
  vault/                 notes of the first account
    Welcome.md
    attachments/         images you paste or drop into notes
    .polarboard/         dates, folder/note tags, settings, version history,
                         personal dictionary, API tokens (auth.json)
    .trash/              deleted notes and folders, recoverable
  vaults/<id>/           accounts created in the app, same layout
  .polarboard-server/    account list, unlocked sessions, share links, account pictures
```

Images are linked with ordinary markdown (`![](attachments/pasted-….png)`), and Obsidian-style `![[image.png]]` embeds and `[[wikilinks]]` work too.

## Accounts

An account *is* a set of notes: its own folders, tags, history, trash, tokens and share links. Polarboard starts with one account called **polarboard**, with no password, so it opens straight away.

- **Pictures and names:** pick a symbol and color or upload a picture in **Settings → General → Account**.
- **Passwords are per account and optional.** An account without one opens for anyone who can reach the server. One with a password asks for it once per device ("keep it unlocked on this device"), and **Lock this account** in the account menu closes it again.
- **More accounts:** use **Add account** in the account menu (the picture at the bottom of the left rail). With more than one, a new browser starts on an account picker. Set `POLARBOARD_PASSWORD` if you don't want just anyone on your network to be able to add accounts.

If Polarboard is reachable from outside your network, put it behind HTTPS (for example Caddy, Traefik, or a Tailscale address).

## API tokens and automations

Tokens belong to one account. They can read and write its notes, but can't change the account, its tokens or its shares. Scripts can also use `curl -u <account-id>:<password>`.

```sh
curl -H "Authorization: Bearer pb_…" http://polarboard.lan:8787/api/tree
curl -H "X-Polarboard: 1" -u work:password -X POST -d '{"path":"Inbox","text":"hi"}' http://polarboard.lan:8787/api/append?vault=work
curl -X POST -H "Authorization: Bearer pb_…" \
  -d '{"path": "Inbox", "text": "- remember this"}' http://polarboard.lan:8787/api/append
```

`/healthz` is always open, for uptime monitors.

## Writing

- **Writing checks** come from [Harper](https://github.com/Automattic/harper): spelling, grammar, punctuation and style, running in your browser. Right-click an underline for fixes, or press `F8` to step through them. Choose which groups to check, your English dialect, single rules and a personal dictionary (shared across devices) in **Settings → Editor**.
- **`[[` suggests notes and `#` suggests tags** as you type.
- **Previews** highlight code, render `$math$` and `$$math$$` with KaTeX, and draw ` ```mermaid ` diagrams. Each library loads only when a note uses it.
- **Daily notes and templates:** `Alt D` opens today's note (folder, name format and template are set in **Settings → Files and links**). Notes in `Templates/` can be inserted with `Alt Shift T`. Templates understand `{{title}}`, `{{date}}`, `{{date:dddd D MMMM}}`, `{{time}}`, `{{yesterday}}`, `{{tomorrow}}` and `{{cursor}}`.
- **Outline and backlinks** panels sit beside notes, tags and search in the sidebar.
- **Edit in preview:** in Read mode, click any paragraph, list, table or diagram to edit its markdown right there (the pencil beside the view switch turns this on and off). Click below the last block to add a new one.
- **Slash menu:** type `/` at the start of a line for headings, checklists, tables, callouts, code, math, diagrams, embeds, templates and more.
- **Tables:** inside a table, `Tab` and `Shift Tab` move between cells and line the columns up. `Enter` at the end of a row adds a row, and `Ctrl Shift L` tidies the whole table.
- **Embedded notes:** a line with just `![[Other note]]` shows that note inside this one, and `![[Other note#Heading]]` shows only that section.
- **Find and replace:** `Ctrl F` finds in the open note (in writing or reading mode), `Ctrl H` also replaces. Match case, whole words and regular expressions (with `$1` in the replacement) are buttons in the bar. Replace all is a single step to undo.
- **Hover previews:** rest the mouse on a `[[link]]` to read that note without leaving this one. Turn it off in **Settings → Editor → Preview**.
- **Side by side:** right-click a note and choose **Open to the side** (or `Ctrl Alt O`, or `Alt Enter` in the quick switcher) to read a second note next to the one you're writing. Drag the divider to resize it; links inside it open in the same pane, `Ctrl` click opens them in the editor. Not on phones.
- **Starred notes:** star the notes you come back to (`Alt S`, or right-click a note) and they're listed in the ★ panel of the sidebar.
- **On a phone:** swipe in from the left edge for the sidebar, press and hold a note for its menu. On iPhone the formatting bar stays just above the keyboard.
- **Keyboard:** in the note list, arrow keys move and open folders, `Enter` opens, `F2` renames, `Delete` deletes and `Shift F10` opens the menu. Menus and dialogs give focus back when they close.
- **Properties:** add them from the note menu, the palette or `/properties`. They're saved as standard front matter (Obsidian reads it too) and shown as a small panel above the note. Notes without properties don't show the panel at all.

## Search

Search is full-text (SQLite FTS5, built into Python), and partial words match: `oat` finds "oats" and "oatmeal". It also understands:

| Write | Finds |
| --- | --- |
| `tag:work` | notes tagged #work (and #work/…) |
| `path:Daily` | notes whose path contains "Daily" |
| `title:plan` | notes whose name contains "plan" |
| `"exact words"` | that exact phrase |
| `-word`, `-tag:draft` | leaves those out |

## Import, export and clean-up

- **Export** (note menu): **PDF** through your browser's print dialog, with optional header, footer, page numbers, paper size, margins, font, title, properties and tags; a self-contained **HTML** file with its images built in; or the **markdown** itself.
- **Import** (Settings → Files and links): `.md`/`.txt` notes, images, or a `.zip` of a folder or an Obsidian vault. Folders are kept, hidden folders like `.obsidian` are skipped, and nothing already there is overwritten.
- **Unused attachments** (Settings → Files and links): finds images and files no note uses any more and moves the ones you pick to the trash.

## Sync, offline and conflicts

Choose how notes sync in **Settings → Sync**:

| Mode | What happens |
| --- | --- |
| **Live** (default) | Saves as you type; changes from other devices appear immediately |
| **Interval** | Saves as you type; checks other devices on a timer |
| **Manual** | Edits stay on this device until you press Sync (`Ctrl S` or the status bar) |

Every note you open is also kept in the browser (optionally all of them). When the connection drops you can keep reading, editing, and even creating notes. The queue is sent when the server is back: right away in Live and Interval, or when you sync in Manual. If a note changed elsewhere in the meantime, the status bar shows **Conflict**; click it to keep your version, theirs, or both.

The app itself is installable and opens offline too, but browsers only allow that over HTTPS or on `localhost`.

## History, git, trash and backups

- **Version history:** earlier versions of notes are kept as you edit (at most every 10 minutes by default). Browse and restore them with `Alt H` or a note's right-click menu. Switch to **Changes** to see what's different since a version, or what that version changed, with the edited words marked.
- **Git (optional):** turn it on in **Settings → Sync** to commit the vault on a schedule, and optionally push to a remote. Use an SSH key on the server for pushing. Off by default.
- **Trash:** deleted notes go to `.trash`. Restore them from **Settings → Sync**. The trash empties itself after 30 days by default.
- **Backups:** **Settings → Sync → Download .zip** gives you the account's notes. Tokens are left out.
- **Scheduled backups (optional):** turn them on in **Settings → Sync → Backup**: hourly, daily or weekly at a time you pick, keeping the last 3 to 90. The zips are written on the server to `POLARBOARD_BACKUPS` (by default `data/backups/<account>/`), and can be downloaded or deleted from the same page. If the server was off at the scheduled time, the backup runs as soon as it's back. Mount a NAS folder there (see `compose.yaml`) so a backup survives the server's own disk failing.

## Sharing

Right-click a note and choose **Share link** to get a read-only link (optionally expiring). Visitors see only that note and its images. The link works wherever your server is reachable.

## Shortcuts

| Keys | Action |
| --- | --- |
| `Ctrl O` | Open a note (quick switcher) |
| `Ctrl Shift P` | Command palette |
| `Ctrl P` | Search inside notes |
| `Ctrl E` | Switch between writing and reading |
| `Ctrl \` | Show or hide the sidebar |
| `Ctrl Shift F` | Focus mode |
| `Alt N` / `Alt D` | New note / today's note |
| `Alt T` / `Alt W` | New tab / close tab |
| `Alt H` | Version history |
| `Ctrl S` | Save and sync now |
| `Ctrl F` / `Ctrl H` | Find / find and replace (`F3`, `Shift F3` next and previous) |
| `Alt S` | Star or unstar the note |
| `Ctrl Alt O` | Open a note to the side |
| `F8` | Next writing suggestion |
| `Ctrl B` / `Ctrl I` / `Ctrl K` | Bold / italic / link |
| `Ctrl Shift L` | Tidy the table under the cursor |

Every shortcut can be changed in **Settings → Hotkeys**. Firefox keeps `Ctrl Shift P` for itself, so rebind the palette there if you use Firefox.

## Project layout

```
server.py              stdlib-only HTTP server + JSON API
static/index.html      page shell          static/share.html   shared-note page
static/app.css         look and feel       static/sw.js        offline app shell
static/app.js          loads static/app/  static/offline.js   offline note cache
static/app/*.js        the app, one module per area (tree, tabs, writing, find, side, …)
static/diff.js         line and word differences for version history
static/settings.js     settings window     static/spell.js     Harper integration
static/editor.js       editor commands     static/rich.js      code, math, diagrams
static/props.js        properties panel    static/export.js    PDF and HTML export
static/print.css       printed and exported pages
static/markdown.js     markdown renderer (escapes all raw HTML)
static/vendor/         bundled open-source libraries (see THIRD_PARTY_NOTICES.md)
```
