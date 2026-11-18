`Ctrl P` searches inside every note. `Ctrl O` jumps to a note by its name.

Search matches the start of words, so `gard` finds "garden" and "gardening". It understands:

| Write | Finds |
| :--- | :--- |
| `tomato basil` | Notes with both words |
| `"cherry tomatoes"` | That exact phrase |
| `tag:project` | Notes tagged #project (and #project/anything) |
| `path:Daily` | Notes whose folder or name contains "Daily" |
| `title:plan` | Notes whose name contains "plan" |
| `-word` | Leaves out notes with that word |
| `-tag:someday` | Leaves out notes with that tag |

Filters combine: `tomato tag:project -path:Daily` finds garden notes about tomatoes, but not daily notes.

Archived notes and the trash stay out of search. Open them from the box and the bin in the left rail.
