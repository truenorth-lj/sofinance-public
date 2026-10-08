import type { SVGProps } from "react";

type BrandMarkProps = SVGProps<SVGSVGElement> & {
  title?: string;
};

/** C3 satellite mark. Fills with currentColor; panel slots stay dark. */
export function BrandMark({ title, className, ...props }: BrandMarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      fill="none"
      className={["block", className].filter(Boolean).join(" ")}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <g transform="rotate(-45 32 32)" fill="currentColor">
        <rect x="19" y="19" width="26" height="26" rx="4.7" />
        <rect x="6" y="23.94" width="10" height="16.12" rx="1.5" />
        <rect x="48" y="23.94" width="10" height="16.12" rx="1.5" />
        <rect x="16" y="30.5" width="3" height="3" />
        <rect x="45" y="30.5" width="3" height="3" />
      </g>
      <g transform="rotate(-45 32 32)" stroke="#000" strokeWidth="1.6" fill="none">
        <path d="M11 23.94v16.12M53 23.94v16.12" />
      </g>
      <path d="M41.36 41.36l5 5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <path
        d="M43.36 51.36a8 8 0 0 0 8-8"
        stroke="currentColor"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}
