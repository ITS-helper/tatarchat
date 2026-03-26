/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        void: {
          DEFAULT: "#000000",
          deep: "#030508",
          panel: "#060b14",
          lift: "#0c1525",
        },
        neon: {
          cyan: "#00e5ff",
          bright: "#5dffc4",
          hot: "#ff00aa",
          magenta: "#ff3dac",
          purple: "#b026ff",
          amber: "#ffee58",
        },
      },
      fontFamily: {
        display: ["Orbitron", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"Share Tech Mono"', "ui-monospace", "monospace"],
      },
      boxShadow: {
        "neon-cyan":
          "0 0 32px rgba(0, 229, 255, 0.35), 0 0 2px rgba(0, 229, 255, 0.8), inset 0 0 24px rgba(0, 229, 255, 0.06)",
        "neon-magenta": "0 0 28px rgba(255, 61, 172, 0.45), 0 0 2px rgba(255, 0, 170, 0.7)",
        panel:
          "0 0 0 1px rgba(0, 229, 255, 0.25), 0 8px 40px rgba(0, 0, 0, 0.75), inset 0 1px 0 rgba(0, 229, 255, 0.12)",
      },
      backgroundImage: {
        "grid-cyber":
          "linear-gradient(rgba(0, 229, 255, 0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 229, 255, 0.045) 1px, transparent 1px)",
      },
    },
  },
  plugins: [],
};
