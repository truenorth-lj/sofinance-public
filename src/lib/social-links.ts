/** Official SoFinance social accounts, shared by the app nav and landing footer. */
export const SOCIAL_LINKS = {
  x: {
    href: "https://x.com/SoFinancelab",
    label: "X",
    ariaLabel: "SoFinance on X",
  },
} as const;

/** Attributes for any outbound social link. */
export const EXTERNAL_LINK_PROPS = {
  target: "_blank",
  rel: "noopener noreferrer",
} as const;
