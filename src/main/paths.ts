import { app } from 'electron'
import { join } from 'path'

// Must run before anything (electron-store, modules) touches userData.
// Default would be %APPDATA%\wicked — which collides case-insensitively with
// the old standalone chat app's %APPDATA%\Wicked data dir.
app.setPath('userData', join(app.getPath('appData'), 'WICKED-Suite'))
