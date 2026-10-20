import type { SVGProps } from "react";
import * as React from "react";

const SvgLumman = (props: SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 514 514"
    width="1em"
    height="1em"
    {...props}
  >
    <path fill="#000" d="M0 0h514v514H0z" />
    <path fill="#fff" d="M220 453V61h74v392z" />
  </svg>
);
export default SvgLumman;
