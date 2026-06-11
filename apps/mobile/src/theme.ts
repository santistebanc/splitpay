export const lightColors = {
  background: "#f4f7fb",
  surface: "#ffffff",
  surfaceSelected: "#e6eefb",
  surfaceLoading: "#eef3fb",
  text: "#16203a",
  heading: "#111a33",
  muted: "#5f6b85",
  label: "#46526f",
  primary: "#2456c4",
  secondary: "#1b2b50",
  danger: "#d23b54",
  dangerSurface: "#fff5f6",
  dangerBorder: "#f0b8c1",
  warning: "#e8a93d",
  border: "#e1e6f0",
  borderSubtle: "#eaeef6",
  borderControl: "#cdd5e6",
  iconMuted: "#828daa",
  chipBorder: "#d3dbed",
  chipSelected: "#dde8fb",
  expenseName: "#1d4499",
  userName: "#b4731f",
  positive: "#16936a",
  negative: "#d23b54"
};

export const darkColors = {
  background: "#0e1424",
  surface: "#161d31",
  surfaceSelected: "#1f2c4d",
  surfaceLoading: "#1a2238",
  text: "#e8ecf7",
  heading: "#f3f6fc",
  muted: "#9aa4c0",
  label: "#c4ccdf",
  primary: "#6ea2ff",
  secondary: "#dde4f5",
  danger: "#ff9aa6",
  dangerSurface: "#331920",
  dangerBorder: "#6e3d46",
  warning: "#f2c14e",
  border: "#283248",
  borderSubtle: "#212a3d",
  borderControl: "#3c4866",
  iconMuted: "#9aa4c0",
  chipBorder: "#3c4866",
  chipSelected: "#22325a",
  expenseName: "#9bbcff",
  userName: "#f5b96b",
  positive: "#4dd0a0",
  negative: "#ff7d8a"
};

export const colors = lightColors;
export type AppColors = typeof lightColors;

export const spacing = {
  pageX: 16,
  headerX: 6,
  rowGap: 12
};

export const typography = {
  header: {
    fontSize: 19,
    lineHeight: 24,
    fontWeight: "800" as const
  },
  logo: {
    fontSize: 30,
    lineHeight: 36,
    fontWeight: "900" as const
  },
  display: {
    fontSize: 30,
    lineHeight: 36,
    fontWeight: "900" as const
  },
  title: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "800" as const
  },
  body: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "600" as const
  },
  rowTitle: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "700" as const
  },
  value: {
    fontSize: 16,
    lineHeight: 21,
    fontWeight: "800" as const
  },
  meta: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600" as const
  },
  label: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: "700" as const
  },
  button: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: "800" as const
  },
  smallButton: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: "800" as const
  },
  money: {
    fontSize: 34,
    lineHeight: 42,
    fontWeight: "800" as const
  }
};
