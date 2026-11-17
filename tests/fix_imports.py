"""Development helper: add missing imports between the modules in static/app/.

Every module exports its top-level declarations. This scans each module for names
that another module exports and that it uses but neither declares nor imports, and
adds them to the import line for that module. It never removes imports.
Run: python3 tests/fix_imports.py [--check]
"""
import re
import sys
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "static" / "app"
EXPORT = re.compile(r"^export\s+(?:async\s+)?(?:function\*?\s+(\w+)|(?:const|let|var)\s+([\w$]+)|class\s+(\w+))", re.M)
TOP = re.compile(r"^(?:export\s+)?(?:async\s+)?(?:function\*?\s+(\w+)|(?:const|let|var)\s+([\w$]+)|class\s+(\w+))", re.M)
IMPORT = re.compile(r"^import \{([^}]*)\} from '\./(\w+)\.js';\n", re.M)


def strip(code):
    code = re.sub(r"/\*.*?\*/", "", code, flags=re.S)
    code = re.sub(r"(?<![:\\])//[^\n]*", "", code)
    return re.sub(r"'(?:\\.|[^'\\\n])*'|\"(?:\\.|[^\"\\\n])*\"", "''", code)


def main(check=False):
    mods = {p.stem: p.read_text() for p in sorted(APP.glob("*.js"))}
    owner = {}
    for m, src in mods.items():
        for g in EXPORT.findall(src):
            owner.setdefault(next(x for x in g if x), m)
    changed = []
    for m, src in mods.items():
        imported = {n.strip() for names, _ in IMPORT.findall(src) for n in names.split(",")}
        imported |= {n.strip() for line in re.findall(r"^import \{([^}]*)\} from '\.\./", src, re.M) for n in line.split(",")}
        local = {next(x for x in g if x) for g in TOP.findall(src)}
        body = strip(IMPORT.sub("", src))
        body = re.sub(r"([{,]\s*)[\w$]+(\s*:)", r"\1\2", body)  # object keys aren't references
        need = {}
        for name, home in owner.items():
            if home == m or name in imported or name in local:
                continue
            # a local variable or destructured parameter with the same name shadows the export
            n = re.escape(name)
            if re.search(r"(?:const|let|var|function)\s+" + n + r"\b|\(\s*\{[^}]*(?<![\w$])" + n + r"(?![\w$])[^}]*\}\s*(?:=[^)]*)?\)", src):
                continue
            after = r"(?=\()" if name in ("$", "$$") else r"(?![\w$])"  # ${ in a template string isn't $()
            if re.search(r"(?<![\w$.])" + re.escape(name) + after, body):
                need.setdefault(home, set()).add(name)
        if not need:
            continue
        changed.append(f"{m}: " + ", ".join(f"{h}.{{{','.join(sorted(n))}}}" for h, n in sorted(need.items())))
        if check:
            continue
        for home, names in need.items():
            rx = re.compile(r"^import \{([^}]*)\} from '\./" + home + r"\.js';\n", re.M)
            hit = rx.search(src)
            if hit:
                allnames = sorted({n.strip() for n in hit.group(1).split(",") if n.strip()} | names)
                src = src[:hit.start()] + f"import {{ {', '.join(allnames)} }} from './{home}.js';\n" + src[hit.end():]
            else:
                last = list(re.finditer(r"^import [^\n]*\n", src, re.M))
                at = last[-1].end() if last else 0
                src = src[:at] + f"import {{ {', '.join(sorted(names))} }} from './{home}.js';\n" + src[at:]
        (APP / f"{m}.js").write_text(src)
    print("\n".join(changed) or "imports complete")
    return not (check and changed)


if __name__ == "__main__":
    sys.exit(0 if main("--check" in sys.argv) else 1)
