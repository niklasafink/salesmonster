import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Sales Monster",
    short_name: "Sales Monster",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f5f6",
    theme_color: "#3d63dd",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
