// Applies the persisted theme before first paint to avoid a light/dark flash.
// Runs as a classic script so it executes before the app bundle. Custom themes
// store their resolved CSS variables in wicked-theme-vars (see stores/settings).
try {
  var saved = localStorage.getItem('wicked-theme-vars')
  if (saved) {
    var custom = JSON.parse(saved)
    if (custom && custom.vars) {
      if (custom.dark) document.documentElement.classList.add('dark')
      for (var name in custom.vars) {
        if (Object.prototype.hasOwnProperty.call(custom.vars, name) && /^--wk-[a-z-]+$/.test(name)) {
          document.documentElement.style.setProperty(name, String(custom.vars[name]))
        }
      }
    }
  } else {
    var t = localStorage.getItem('wicked-theme')
    var dark =
      t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
    if (dark) document.documentElement.classList.add('dark')
  }
} catch (e) {
  /* first run or storage unavailable — default theme applies */
}
