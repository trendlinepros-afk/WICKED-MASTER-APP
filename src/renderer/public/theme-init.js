// Applies the persisted theme before first paint to avoid a light/dark flash.
// Runs as a classic script so it executes before the app bundle.
try {
  var t = localStorage.getItem('wicked-theme')
  var dark =
    t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
  if (dark) document.documentElement.classList.add('dark')
} catch (e) {
  /* first run or storage unavailable — default theme applies */
}
