// Mirrors the @theme tokens in src/app/globals.css for code that needs raw values.
export const INK_COLORS = {
  canvas: "#0b0b0b",
  cardBg: "#151514",
  ink: "#0d0d0c",
  cream: "#f4f0e6",
  lemon: "#f3e76b",
  mint: "#84e9c5",
  lilac: "#cdc6ff",
  coral: "#ff9c85",
  smoke: "#98948b",
  radii: {
    card: "28px",
    button: "9999px",
    badge: "9999px",
  },
} as const;

export const INK_RADII = INK_COLORS.radii;
