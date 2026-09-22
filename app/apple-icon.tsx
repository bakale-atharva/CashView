import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// Same "Stamped C" mark as app/icon.svg, rendered to PNG at build time —
// apple-icon only accepts jpg/jpeg/png, not svg (see next/dist/docs).
// Opaque ground because iOS composites no background of its own.
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#1f2b24",
        }}
      >
        <svg
          width="112"
          height="112"
          viewBox="0 0 180 180"
          xmlns="http://www.w3.org/2000/svg"
        >
          <g fill="#ab3327" transform="rotate(-8 90 90)">
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M131.36 124.71 A54 54 0 1 1 131.36 55.29 L110.68 72.64 A27 27 0 1 0 110.68 107.36 Z"
            />
          </g>
        </svg>
      </div>
    ),
    { ...size }
  );
}
