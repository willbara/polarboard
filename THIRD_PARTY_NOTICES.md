# Third-party notices

Polarboard bundles the following open-source projects, unchanged, under `static/vendor/`. Each folder includes the project's original license file. They are also credited in the app under **Settings → General → Credits**.

| Project | Version | License | Used for | Source |
| --- | --- | --- | --- | --- |
| [Harper](https://github.com/Automattic/harper) (`harper.js`) | 3.2.0 | Apache-2.0 | Spelling, grammar and style checks, run locally in the browser | `static/vendor/harper/` |
| [highlight.js](https://highlightjs.org) | 11.12.0 | BSD-3-Clause | Code highlighting in the preview | `static/vendor/hljs/` |
| [KaTeX](https://katex.org) | 0.19.1 | MIT | Math in the preview | `static/vendor/katex/` |
| [Mermaid](https://mermaid.js.org) | 12.3.0 | MIT | Diagrams in the preview | `static/vendor/mermaid/` |

Harper is copyright Automattic and Elijah Potter. highlight.js is copyright Josh Goebel and contributors. KaTeX is copyright Khan Academy and contributors. Mermaid is copyright Knut Sveidqvist and contributors. See each license file for the full terms.

Harper is used through its "slim" WebAssembly build, which produced identical results to the full build in testing (971 rules) and loads one file instead of two.
