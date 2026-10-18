import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/* iOS ignores SVG icons and rounds the corners itself, so this is a full-bleed PNG */
export default function AppleIcon() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#fff" }}>
      <svg width="128" height="128" viewBox="0 0 32 32">
        <path fill="#000" d="M9.2 7.6Q5.6 6.4 5.2 1.8Q8.6 4.6 12.6 5.9A11 11 0 0 1 19.4 5.9Q23.4 4.6 26.8 1.8Q26.4 6.4 22.8 7.6A10 10 0 0 1 27 15.5V25a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V15.5A10 10 0 0 1 9.2 7.6Z" />
        <circle cx="16" cy="14" r="4.4" fill="#fff" />
        <circle cx="17.1" cy="13.1" r="1.8" fill="#000" />
        <path d="M9.6 25l3.9-3.1 3 2 5.7-4.4M19.2 19.5h3v3" fill="none" stroke="#fff" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>,
    size,
  );
}
