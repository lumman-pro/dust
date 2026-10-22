export type FrameProps = Record<string, string>;

const FRAME_PROP_PARAM_PREFIX = "props.";

export const FRAME_PROP_NAME_REGEX = /^[A-Za-z][A-Za-z0-9_]*$/;

export const REACT_RESERVED_PROP_NAMES = new Set(["key", "ref"]);

/**
 * @cc [owner:tdraier,label:product] frame-props-from-url
 * Each `props.<name>=<value>` search param MUST become the string prop `<name>`, the first value
 * when repeated, for a name of a letter then letters, digits or `_` other than React's `key` and
 * `ref`; any other param MUST NOT become a prop.
 */
export function getFramePropsFromSearchParams(
  searchParams: Record<string, string | string[] | undefined>
): FrameProps {
  const props: FrameProps = {};
  for (const [param, value] of Object.entries(searchParams)) {
    if (!param.startsWith(FRAME_PROP_PARAM_PREFIX)) {
      continue;
    }
    const name = param.slice(FRAME_PROP_PARAM_PREFIX.length);
    const propValue = Array.isArray(value) ? value[0] : value;
    if (
      FRAME_PROP_NAME_REGEX.test(name) &&
      !REACT_RESERVED_PROP_NAMES.has(name) &&
      propValue !== undefined
    ) {
      props[name] = propValue;
    }
  }
  return props;
}
