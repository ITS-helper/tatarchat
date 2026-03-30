/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        tg: {
          bg: "#17212b",
          sidebar: "#0e1621",
          panel: "#1b2735",
          input: "#242f3d",
          header: "#1e2c3a",
          msg: "#182533",
          "msg-own": "#2b5278",
          accent: "#5eaeea",
          link: "#6ab2f2",
          green: "#4dcd81",
          text: "#f5f5f5",
          "text-sec": "#7e919e",
          "text-muted": "#546778",
          border: "#1a2836",
          hover: "#202d3b",
          danger: "#e05d5d",
          online: "#4dcd81",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};
