export const INK_COLORS = {
  canvas: "#050505",
  cardBg: "#0a0a0a",
  cardBorder: "neutral-800",
  logoBg: "neutral-900",
  logoBorder: "neutral-800",
  textPrimary: "neutral-100",
  textSecondary: "neutral-300",
  textTertiary: "neutral-500",
  textMuted: "neutral-600",
  buttonBorder: "neutral-700",
  buttonBorderHover: "neutral-600",
  buttonBgHover: "neutral-900/50",
  dividerStrong: "neutral-800/60",
  dividerLight: "neutral-800/30",
  radii: {
    card: "20px",
    button: "12px",
    badge: "9999px",
  },
} as const;

export const INK_RADII = INK_COLORS.radii;
