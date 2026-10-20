import type { IconProps } from "@sparkle/components/Icon";
import { Icon } from "@sparkle/components/Icon";
import { AlertCircle } from "@sparkle/icons/v2-stroke";
import { cn } from "@sparkle/lib/utils";
import { cva } from "class-variance-authority";
import React, { forwardRef } from "react";

// Redesigned input, added alongside the existing Input (which is unchanged).
// xs/sm/md = 24/32/40px. The field is a wrapper around a transparent inner
// <input> so slots and icons share one code path. All colors come from
// semantic tokens that flip on their own under `.dark`, so no `dark:` is needed.

const MESSAGE_STATUS = ["info", "default", "error"] as const;

type MessageStatus = (typeof MESSAGE_STATUS)[number];

export const INPUT_SIZES = ["xs", "sm", "md"] as const;
export type InputSizeType = (typeof INPUT_SIZES)[number];
export const INPUT_VARIANTS = ["default", "borderless"] as const;
export type InputVariantType = (typeof INPUT_VARIANTS)[number];

const messageVariantStyles: Record<MessageStatus, string> = {
  info: "text-muted-foreground",
  default: "text-muted-foreground",
  error: "text-foreground-warning",
};

const messageVariant = cva("", {
  variants: {
    status: messageVariantStyles,
  },
  defaultVariants: {
    status: "info",
  },
});

const fieldVariants = cva(
  cn(
    "flex w-full items-center overflow-hidden border transition-colors",
    // Light: a white field on any surface. Dark: follow the surface (the
    // page background token is darker than the panel and modal surfaces, so
    // a fixed fill reads as a dark well there).
    "bg-background dark:bg-transparent"
  ),
  {
    variants: {
      size: {
        xs: "h-6 rounded-lg text-xs",
        // 16px on small viewports so Mobile Safari does not zoom on focus.
        sm: "h-8 rounded-xl text-base md:text-sm",
        md: "h-10 rounded-[15px] text-base md:text-sm",
      },
      state: {
        // The resting look of the default state depends on `variant`, see
        // `compoundVariants` below.
        default: "",
        error: cn("border-warning-500", "focus-within:border-warning-600"),
        disabled: cn(
          "cursor-not-allowed border-transparent",
          "bg-muted dark:bg-foreground/5"
        ),
      },
      variant: {
        default: "",
        borderless: "",
      },
    },
    compoundVariants: [
      {
        state: "default",
        variant: "default",
        class: cn(
          "border-border-form",
          "focus-within:border-border-form-active",
          // Filled (has a value) and not focused: a muted fill only. The
          // border goes back to its resting color so the field does not look
          // focused after the user moves on. In dark mode the fill is a
          // translucent foreground tint rather than the near-black `muted`
          // token, so it lifts lighter surfaces (modal) instead of sinking.
          "[&:has(input:not(:placeholder-shown)):not(:focus-within)]:bg-muted",
          "dark:[&:has(input:not(:placeholder-shown)):not(:focus-within)]:bg-foreground/5"
        ),
      },
      {
        state: "default",
        variant: "borderless",
        // No border or fill in any interaction state: the surrounding surface
        // (e.g. a command palette) provides the framing. The border is removed
        // rather than made transparent so inline icons sit at exactly the
        // icon margin from the field edge; the fixed `h-*` keeps the outer
        // height identical to the default variant.
        class: "border-0 bg-transparent",
      },
    ],
    defaultVariants: {
      size: "sm",
      state: "default",
      variant: "default",
    },
  }
);

const innerInputVariants = cva(
  cn(
    "h-full w-full min-w-0 flex-1 border-0 bg-transparent outline-hidden shadow-none ring-0",
    // <input> does not inherit typography from its wrapper by default.
    "font-sans text-inherit",
    "text-foreground",
    "placeholder:text-faint",
    "disabled:cursor-not-allowed disabled:text-faint"
  ),
  {
    variants: {
      size: {
        xs: "px-2 text-xs",
        sm: "px-3 text-base md:text-sm",
        md: "px-3 text-base md:text-sm",
      },
    },
    defaultVariants: {
      size: "sm",
    },
  }
);

const labelVariants = cva("pb-0.5 font-medium text-foreground", {
  variants: {
    size: {
      xs: "text-xs",
      sm: "text-sm",
      md: "text-sm",
    },
  },
  defaultVariants: {
    size: "sm",
  },
});

// Full-height muted box flanking the field for a unit/currency (prefix/suffix).
// Sized to its content with a floor, so a word ("days") is not clipped by the
// field's overflow-hidden while a single glyph ("$") keeps its square box.
const slotBoxVariants = cva(
  cn(
    "flex h-full shrink-0 items-center justify-center",
    "bg-muted dark:bg-foreground/5"
  ),
  {
    variants: {
      size: {
        xs: "min-w-6 px-2",
        sm: "min-w-8 px-2.5",
        md: "min-w-10 px-3",
      },
    },
    defaultVariants: {
      size: "sm",
    },
  }
);

// Passed as `Icon`'s `size`: `Icon` applies its own size class after
// `className`, so a size class passed through `className` would be ignored.
const ICON_SIZE: Record<InputSizeType, IconProps["size"]> = {
  xs: "2xs",
  sm: "xs",
  md: "xs",
};

// Inline icons sit at the same inset as the inner input's horizontal padding.
const ICON_MARGIN: Record<InputSizeType, { left: string; right: string }> = {
  xs: { left: "ml-2", right: "mr-2" },
  sm: { left: "ml-3", right: "mr-3" },
  md: { left: "ml-3", right: "mr-3" },
};

export interface InputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "size" | "prefix"
> {
  /** Field height: "xs" (24px), "sm" (32px), or "md" (40px); a number falls back to "sm". */
  size?: InputSizeType | number;
  /** Helper or error text shown under the field, colored by `messageStatus`. */
  message?: string | null;
  /** How the `message` is rendered: "info" and "error" show an icon, "error" also colors the field. */
  messageStatus?: MessageStatus;
  value?: string | number | readonly string[] | null;
  /** Forces the error (warning border) state regardless of `messageStatus`. */
  isError?: boolean;
  /**
   * "default" draws the form border and a muted fill when filled; "borderless"
   * draws neither, for fields framed by their surface (e.g. a command palette).
   * Error and disabled states render the same in both variants.
   */
  variant?: InputVariantType;
  /** Classes applied to the field wrapper. */
  className?: string;
  /** Classes applied to the outer container (label + field + message). */
  containerClassName?: string;
  /** Caption rendered above the field. */
  label?: string;
  /** Icon rendered inline at the start of the field. */
  icon?: React.ComponentType;
  /** Icon rendered inline at the end of the field. */
  iconRight?: React.ComponentType;
  /** Content of a full-height muted box before the field (e.g. a unit or currency). */
  prefix?: React.ReactNode;
  /** Content of a full-height muted box after the field (e.g. a unit or currency). */
  suffix?: React.ReactNode;
  /**
   * Renders `suffix` in the muted box's faint text style, for a unit/currency
   * label (e.g. "credits/month", "days") instead of callers each re-styling
   * that text themselves.
   */
  isUnit?: boolean;
}

/**
 * A single-line text field for short, freeform input such as a name, email, or
 * search term, with an optional label, helper or error message with status
 * colouring, and the standard HTML input types. Use it to collect a short piece
 * of text or a number in forms, search bars, and settings panels; for
 * multi-line input use TextArea, for search-specific affordances use
 * SearchInput.
 *
 * @summary Single-line text field.
 */
/**
 * @cc [owner:ClementAupiais,label:react] borderless-variant-has-no-chrome
 * When `variant` is "borderless" and the field is neither in error nor disabled, the field
 * wrapper MUST NOT render a visible border or background fill in any interaction state
 * (resting, focused, filled). The error and disabled states MUST take precedence over the
 * variant and render identically to the "default" variant.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      containerClassName,
      size: rawSize = "sm",
      message,
      messageStatus,
      value,
      label,
      isError,
      variant = "default",
      disabled,
      icon,
      iconRight,
      prefix,
      suffix,
      isUnit,
      ...props
    },
    ref
  ) => {
    const size: InputSizeType = typeof rawSize === "number" ? "sm" : rawSize;
    const resolvedSuffix = isUnit ? (
      <span className="text-faint">{suffix}</span>
    ) : (
      suffix
    );
    const state =
      isError || (message && messageStatus === "error")
        ? "error"
        : disabled
          ? "disabled"
          : "default";
    return (
      <div className={cn("flex flex-col gap-1.5", containerClassName)}>
        {label && (
          <label htmlFor={props.name} className={labelVariants({ size })}>
            {label}
          </label>
        )}
        <div className={cn(fieldVariants({ size, state, variant }), className)}>
          {prefix && <div className={slotBoxVariants({ size })}>{prefix}</div>}
          {icon && (
            <Icon
              visual={icon}
              size={ICON_SIZE[size]}
              className={cn("text-faint", ICON_MARGIN[size].left)}
            />
          )}
          <input
            ref={ref}
            className={innerInputVariants({ size })}
            data-1p-ignore={props.type !== "password"}
            value={value ?? undefined}
            disabled={disabled}
            {...props}
          />
          {iconRight && (
            <Icon
              visual={iconRight}
              size={ICON_SIZE[size]}
              className={cn("text-faint", ICON_MARGIN[size].right)}
            />
          )}
          {resolvedSuffix && (
            <div className={slotBoxVariants({ size })}>{resolvedSuffix}</div>
          )}
        </div>
        {message && (
          <div
            className={cn(
              "flex items-start gap-0.5 text-xs",
              messageVariant({ status: messageStatus })
            )}
          >
            {(messageStatus === "info" || messageStatus === "error") && (
              <Icon visual={AlertCircle} size="xs" />
            )}
            {message}
          </div>
        )}
      </div>
    );
  }
);

Input.displayName = "Input";
