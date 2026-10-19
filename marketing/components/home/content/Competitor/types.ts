// Shared CTA button configuration
export interface CTAConfig {
  label: string;
  href: string;
}

// ===== Content types =====

export interface FAQItem {
  question: string;
  answer: string;
}

export interface FinalCTAConfig {
  title: string;
  subtitle?: string;
  primaryCTA: CTAConfig;
  secondaryCTA: CTAConfig;
  trustText?: string;
  socialProofLogos?: string[];
}
