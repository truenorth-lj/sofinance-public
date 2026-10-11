import type { SVGProps } from "react";

type BrandMarkProps = SVGProps<SVGSVGElement> & {
  title?: string;
};

/** Orbit mark: a satellite dot riding a ring around the core. Draws in currentColor. */
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
      <circle cx="32" cy="32" r="8" fill="currentColor" />
      <path
        d="M54 25.28A23 23 0 1 1 38.72 10"
        stroke="currentColor"
        strokeWidth="3.5"
        fill="none"
        strokeLinecap="round"
      />
      <circle cx="48.26" cy="15.74" r="6" fill="currentColor" />
    </svg>
  );
}
