/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}', './modules/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // theme tokens — actual values live in src/renderer/src/styles/index.css
        bg: 'rgb(var(--wk-bg) / <alpha-value>)',
        surface: 'rgb(var(--wk-surface) / <alpha-value>)',
        raised: 'rgb(var(--wk-raised) / <alpha-value>)',
        edge: 'rgb(var(--wk-edge) / <alpha-value>)',
        ink: 'rgb(var(--wk-ink) / <alpha-value>)',
        muted: 'rgb(var(--wk-muted) / <alpha-value>)',
        accent: 'rgb(var(--wk-accent) / <alpha-value>)',
        'accent-ink': 'rgb(var(--wk-accent-ink) / <alpha-value>)',
        danger: 'rgb(var(--wk-danger) / <alpha-value>)',
        ok: 'rgb(var(--wk-ok) / <alpha-value>)',
        warn: 'rgb(var(--wk-warn) / <alpha-value>)'
      }
    }
  },
  plugins: []
}
