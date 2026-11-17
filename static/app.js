// Polarboard client. The code lives in static/app/; this file loads it and starts the app.
// core.js holds shared state and helpers and imports nothing else from the app,
// so it is always ready first. boot() runs only after every module has loaded.

import './app/core.js';
import './app/ui.js';
import './app/prefs.js';
import './app/sync.js';
import './app/tree.js';
import './app/notes.js';
import './app/tabs.js';
import './app/writing.js';
import './app/layout.js';
import './app/panels.js';
import './app/spellui.js';
import './app/suggest.js';
import './app/daily.js';
import './app/commands.js';
import './app/accounts.js';
import './app/find.js';
import './app/mobile.js';
import './app/hover.js';
import './app/side.js';
import { boot } from './app/shell.js';

boot();
