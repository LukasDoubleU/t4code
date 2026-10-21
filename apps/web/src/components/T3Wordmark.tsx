import type { SVGProps } from "react";

// Draws the fork's T4 mark, the letters of assets/prod/t4/icon.svg. The
// component keeps upstream's name so its call sites stay untouched.
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 37 87.84 56" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M0 37H48.8V47.56H30.88V93H17.92V47.56H0ZM67.88 37H80.84V70.6H87.84V81.16H80.84V93H67.88V81.16H40.88V70.6ZM56.274 70.6H67.88V56.157Z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  );
}
