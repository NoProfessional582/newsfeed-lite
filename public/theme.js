// Set the theme before first paint so a saved choice never flashes the other palette.
{ let t; try { t = localStorage.getItem("theme"); } catch {}
  document.documentElement.dataset.theme = t === "light" || t === "dark" ? t : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; }
