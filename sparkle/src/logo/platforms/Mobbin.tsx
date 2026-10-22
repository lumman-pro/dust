import type { SVGProps } from "react";
import * as React from "react";

const SvgMobbin = (props: SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="1em"
    height="1em"
    fill="none"
    viewBox="0 0 24 24"
    {...props}
  >
    <rect width={24} height={24} fill="#F7F7F7" rx={6} />
    <path
      fill="#141414"
      d="M13.923 16.148H9.238v-2.16l-2.02 2.16L3 16.146v-4.407L6.666 7.86h5.068v2.062l1.974-2.062h4.39v3.391h2.903v4.897h-5.165v-2.045z"
    />
  </svg>
);
export default SvgMobbin;
