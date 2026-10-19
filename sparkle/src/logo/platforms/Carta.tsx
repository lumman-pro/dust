import type { SVGProps } from "react";
import * as React from "react";

const SvgCarta = (props: SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="1em"
    height="1em"
    fill="none"
    viewBox="0 0 24 24"
    {...props}
  >
    <rect width={24} height={24} fill="#000" rx={6} />
    <path
      fill="#fff"
      d="M6.345 12.021C6.345 8.228 9.531 6 12.39 6c2.046 0 3.954.771 4.977 2.55l-1.911 1.113a3.597 3.597 0 0 0-3.027-1.613c-1.682 0-3.683 1.32-3.683 3.933 0 2.55 1.911 3.956 3.84 3.956.1341 0 2.456-.752 3.114-1.911l1.955.906C16.55 16.935 14.571 18 12.278 18 9.39 17.997 6.345 15.767 6.345 12.021Z"
    />
  </svg>
);
export default SvgCarta;
