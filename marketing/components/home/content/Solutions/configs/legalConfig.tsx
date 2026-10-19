import { CheckCircle, MagicWand02, Rocket02, Users01 } from "@dust-tt/sparkle";
import type {
  BenefitsProps,
  MetricProps,
} from "@marketing/components/home/content/Solutions/BenefitsSection";
import type { QuoteProps } from "@marketing/components/home/content/Solutions/CustomerStoriesSection";
import type { DemoVideoProps } from "@marketing/components/home/content/Solutions/DemoVideoSection";
import type { UseCaseProps } from "@marketing/components/home/content/Solutions/UseCasesSection";
import type {
  HeroProps,
  pageSettingsProps,
} from "@marketing/components/home/content/Solutions/configs/utils";

// Config exports
export const pageSettings: pageSettingsProps = {
  uptitle: "Legal",
  title: <>Accelerate Legal Operations and Compliance</>,
  accentColor: "text-brand-electric-blue",
  description: (
    <>
      Assist your teams on legal or compliance reviews, and make legal support
      more self-served across your organization.
    </>
  ),
  bulletPoints: [
    "Get instant legal guidance and answers.",
    "Review contracts with expert insights.",
    "Navigate legal research efficiently.",
    "Generate compliant legal documents.",
  ],
  image: "/static/landing/legal/legalreviewer.png",
  seo: {
    title: "AI Legal Agents: Accelerate Legal Operations and Compliance",
    description:
      "Assist your teams on legal or compliance reviews, and make legal support more self-served across your organization. Review contracts, navigate research efficiently.",
  },
};

export const Hero: HeroProps = {
  uptitle: pageSettings.uptitle,
  title: pageSettings.title,
  description: pageSettings.description,
  visuals: [
    {
      src: "/static/landing/legal/legal1.png",
      alt: "Legal Visual 1",
      depth: -30,
    },
    {
      src: "/static/landing/legal/legal2.png",
      alt: "Legal Visual 2",
      depth: -10,
    },
    {
      src: "/static/landing/legal/legal3.png",
      alt: "Legal Visual 3",
      depth: 20,
    },
    {
      src: "/static/landing/legal/legal4.png",
      alt: "Legal Visual 4",
      depth: 50,
    },
  ],
  ctaButtons: {
    primary: {
      label: "Get started",
      href: "/home/pricing",
      icon: Rocket02,
    },
    secondary: {
      label: "Talk to sales",
      href: "/home/contact",
    },
  },
};

export const Benefits: BenefitsProps = {
  sectionTitle: "Transform your legal operations into strategic advantage",
  items: [
    {
      icon: MagicWand02,
      title: "Focus on expertise",
      description:
        "Maximize lawyer time by automating routine legal guidance and reviews.",
    },
    {
      icon: CheckCircle,
      title: "Ensure compliance",
      description:
        "Instantly verify requirements and stay current with regulatory changes.",
    },
    {
      icon: Users01,
      title: "Scale legal support",
      description:
        "Turn legal expertise into accessible guidance for the entire organization.",
    },
  ],
};

export const Metrics: MetricProps = {
  metrics: [
    {
      value: "50%",
      description: <>time saved on legal tasks</>,
    },
    {
      value: "80%",
      description: <>first level legal answers deflected</>,
    },
  ],
  color: "golden",
};

export const UseCases: UseCaseProps = {
  sectionTitle: "Your use cases, your way",
  sectionDescription:
    "Customize and automate tasks without writing a single line of code.",
  items: [
    {
      title: "Legal helpdesk",
      content:
        "Provide team members instant legal guidance using your approved policies, documentation and external sources.",
      images: ["/static/landing/legal/asklegal.png"],
    },
    {
      title: "Legal review",
      content:
        "Analyze contracts or RFPs automatically for compliance and risk, highlighting key terms and obligations.",
      images: ["/static/landing/legal/legalreviewer.png"],
    },
    {
      title: "Legal research and monitoring",
      content:
        "Navigate legal databases and documentation to surface relevant precedents. Monitor regulation updates for compliance check.",
      images: ["/static/landing/legal/regulatorywatch.png"],
    },

    {
      title: "Document creation",
      content:
        "Generate legal documents and agreements using pre-approved templates and clauses.",
      images: ["/static/landing/legal/contractwriter.png"],
    },
  ],
};

export const Quote: QuoteProps = {
  quote:
    "Dust transformed our privacy reviews. It handles compliance checks, suggests improvements, and drafts communications. It both cuts our review time and helps pressure-test our legal interpretations.",
  name: "Thomas Adhumeau",
  title: "Chief Privacy Officer at Didomi",
  logo: "/static/landing/logos/color/didomi.png",
};

export const DemoVideo: DemoVideoProps = {
  sectionTitle: "Watch Dust in motion",
  videoUrl: "https://fast.wistia.net/embed/iframe/zzbhe95pvz",
  showCaptions: true,
};
