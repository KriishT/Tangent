import { useId } from "react";

type MarkProps = {
  size?: number;
  className?: string;
  gradientId?: string;
  /** Sidebar uses light tile; app icon uses full gradient tile. */
  variant?: "app" | "sidebar";
};

/** Tangent mark — orbit ring + ray. Matches taskbar / tray icon. */
export function LogoMark({
  size = 30,
  className,
  gradientId,
  variant = "sidebar",
}: MarkProps) {
  const autoId = useId().replace(/:/g, "");
  const gid = gradientId ?? `tg-${autoId}`;
  const isApp = variant === "app";

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <defs>
        <linearGradient id={`${gid}-bg`} x1="4" y1="29" x2="28" y2="3" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2a3478" />
          <stop offset="0.45" stopColor="#4a5bb8" />
          <stop offset="1" stopColor="#7b8fe8" />
        </linearGradient>
        <linearGradient id={`${gid}-shine`} x1="16" y1="2.5" x2="16" y2="16" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffffff" stopOpacity="0.2" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {isApp ? (
        <>
          <rect width="32" height="32" rx="7.1" fill={`url(#${gid}-bg)`} />
          <rect width="32" height="32" rx="7.1" fill={`url(#${gid}-shine)`} />
        </>
      ) : (
        <rect x="0.5" y="0.5" width="31" height="31" rx="7.1" fill={`url(#${gid}-bg)`} />
      )}
      <circle
        cx="12.25"
        cy="19.6"
        r="6.7"
        stroke="#ffffff"
        strokeWidth="3.35"
        strokeLinecap="round"
        strokeDasharray="31.5 10.6"
        strokeDashoffset="3.7"
      />
      <line
        x1="16.8"
        y1="15.1"
        x2="23.4"
        y2="8.5"
        stroke="#ffffff"
        strokeWidth="3.35"
        strokeLinecap="round"
      />
      <circle cx="16.8" cy="15.1" r="1.6" fill="#ffffff" />
    </svg>
  );
}

export default function Logo() {
  const gradientId = useId().replace(/:/g, "");

  return (
    <div className="logo" aria-label="Tangent">
      <LogoMark size={32} gradientId={`logo-${gradientId}`} variant="app" className="logo-mark" />
      <div className="logo-wordmark" aria-hidden>
        <span className="logo-tan">Tan</span>
        <span className="logo-gent">gent</span>
      </div>
    </div>
  );
}
