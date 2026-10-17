import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/* iOS ignores SVG icons and rounds the corners itself, so this is a full-bleed PNG */
export default function AppleIcon() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#3d63dd" }}>
      <svg width="104" height="104" viewBox="0 0 32 32" fill="#fff" stroke="#fff" strokeWidth="2" strokeLinejoin="round">
        <path d="M28.5 3.5 3.5 13.5l9 4.5Z" />
        <path d="M28.5 3.5 14 19.5l4.5 9Z" />
      </svg>
    </div>,
    size,
  );
}
