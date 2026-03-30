/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        tc: {
          bg: "#1a1f2e",
          sidebar: "#151a26",
          panel: "#1e2535",
          input: "#252d3d",
          header: "#1c2333",
          msg: "#232b3b",
          "msg-own": "#2a4a6b",
          accent: "#4a9ede",
          "accent-hover": "#3d8bcf",
          link: "#5badf0",
          green: "#5cc97e",
          text: "#e8ecf1",
          "text-sec": "#8d99a8",
          "text-muted": "#5a6577",
          border: "#2a3244",
          hover: "#252d3d",
          danger: "#d95454",
          online: "#5cc97e",
          asphalt: "#3a4354",
          "asphalt-light": "#4d5566",
          "asphalt-dark": "#2d3444",
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
