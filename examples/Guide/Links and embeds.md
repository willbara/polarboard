## Links between notes

Put a note's name in double brackets to link to it: [[Welcome]]. Typing `[[` suggests notes as you go.

- **Another label:** [[Garden planner|the garden]] shows "the garden" but opens the Garden planner.
- **A heading:** [[Writing and formatting#Emphasis]] opens that note at that heading.
- **A note that doesn't exist yet:** [[Someday]] looks faded. Click it to create it.
- **Ordinary Markdown links** work too: [the search guide](Guide/Search.md), or a web page like [the Harper project](https://github.com/Automattic/harper).

Rest the mouse on a link to preview the note without leaving this one. `Ctrl` click opens it in a new tab, and right-click → **Open to the side** puts it next to this one.

When you rename or move a note, links to it in other notes are updated for you (turn this off in **Settings → Files and links**).

## Backlinks

The **Backlinks** panel (the chain icon at the top of the sidebar) lists every note that links to the open one. It also lists notes that mention its name without linking, so you can turn those into links.

## Embedding a note

A line with just `![[Another note]]` shows that note inside this one. Add `#Heading` to show only that section. This is the "Moving around" section of [[Keyboard shortcuts]]:

![[Keyboard shortcuts#Moving around]]

## Images

Paste or drop an image into a note and it's uploaded to the `attachments` folder and linked for you. Both ways of writing an image work:

![[tram.svg|360]]

![A sunrise over the hills](attachments/aurora.svg)

The number after `|` sets the width in pixels. **Settings → Files and links** finds images no note uses any more.
