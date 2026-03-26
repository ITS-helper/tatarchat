/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        void: {
          DEFAULT: "#030712",
          deep: "#0a1628",
          panel: "#0d1f35",
          lift: "#132a45",
        },
        neon: {
          cyan: "#22d3ee",
          bright: "#00fff5",
          magenta: "#f472b6",
          purple: "#a855f7",
          amber: "#fbbf24",
        },
      },
      fontFamily: {
        display: ["Orbitron", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"Share Tech Mono"', "ui-monospace", "monospace"],
      },
      boxShadow: {
        "neon-cyan": "0 0 24px rgba(34, 211, 238, 0.2), inset 0 0 20px rgba(34, 211, 238, 0.03)",
        "neon-magenta": "0 0 20px rgba(244, 114, 182, 0.25)",
        panel: "0 0 0 1px rgba(34, 211, 238, 0.15), 0 8px 32px rgba(0, 0, 0, 0.4)",
      },
      backgroundImage: {
        "grid-cyber":
          "linear-gradient(rgba(34, 211, 238, 0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(34, 211, 238, 0.04) 1px, transparent 1px)",
      },
    },
  },
  plugins: [],
};
