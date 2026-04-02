/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        tc: {
          bg:              "rgb(var(--tc-bg) / <alpha-value>)",
          sidebar:         "rgb(var(--tc-sidebar) / <alpha-value>)",
          panel:           "rgb(var(--tc-panel) / <alpha-value>)",
          input:           "rgb(var(--tc-input) / <alpha-value>)",
          header:          "rgb(var(--tc-header) / <alpha-value>)",
          msg:             "rgb(var(--tc-msg) / <alpha-value>)",
          "msg-own":       "rgb(var(--tc-msg-own) / <alpha-value>)",
          accent:          "rgb(var(--tc-accent) / <alpha-value>)",
          "accent-hover":  "rgb(var(--tc-accent-hover) / <alpha-value>)",
          link:            "rgb(var(--tc-link) / <alpha-value>)",
          green:           "rgb(var(--tc-green) / <alpha-value>)",
          text:            "rgb(var(--tc-text) / <alpha-value>)",
          "text-sec":      "rgb(var(--tc-text-sec) / <alpha-value>)",
          "text-muted":    "rgb(var(--tc-text-muted) / <alpha-value>)",
          border:          "rgb(var(--tc-border) / <alpha-value>)",
          hover:           "rgb(var(--tc-hover) / <alpha-value>)",
          danger:          "rgb(var(--tc-danger) / <alpha-value>)",
          online:          "rgb(var(--tc-online) / <alpha-value>)",
          asphalt:         "rgb(var(--tc-asphalt) / <alpha-value>)",
          "asphalt-light": "rgb(var(--tc-asphalt-light) / <alpha-value>)",
          "asphalt-dark":  "rgb(var(--tc-asphalt-dark) / <alpha-value>)",
        },
      },
      animation: {
        'fade-in': 'tc-fade-in 0.4s ease-out both',
        'glow-pulse': 'tc-glow-pulse 2.5s ease-in-out infinite',
        'slide-up': 'tc-slide-up 0.3s ease-out both',
      },
      keyframes: {
        'tc-fade-in': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'tc-glow-pulse': {
          '0%, 100%': { boxShadow: '0 0 12px rgba(255,185,50,0.25)' },
          '50%': { boxShadow: '0 0 28px rgba(255,185,50,0.55)' },
        },
        'tc-slide-up': {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};
