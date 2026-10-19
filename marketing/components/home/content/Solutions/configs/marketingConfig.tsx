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
  uptitle: "Marketing",
  title: <>Create On-Brand Content At Scale</>,
  accentColor: "text-brand-orange-golden",
  description: (
    <>
      Scale content production, maintain brand consistency,
      and&nbsp;optimize&nbsp;reach across channels.
    </>
  ),
  bulletPoints: [
    "Localize content in multiple languages with brand consistency.",
    "Draft high-quality customer stories following company templates.",
    "Create compelling social media copy.",
    "Monitor industry and competitor news.",
  ],
  image: "/static/landing/marketing/crossMedia.png",
  seo: {
    title: "AI Marketing Agents: Create On-Brand Content at Scale",
    description:
      "Scale content production, maintain brand consistency, and optimize reach across channels. Localize content, draft customer stories, create social media copy.",
  },
};

export const Hero: HeroProps = {
  uptitle: pageSettings.uptitle,
  title: pageSettings.title,
  description: pageSettings.description,
  visuals: [
    {
      src: "/static/landing/marketing/marketing1.png",
      alt: "Marketing Visual 1",
      depth: -30,
    },
    {
      src: "/static/landing/marketing/marketing2.png",
      alt: "Marketing Visual 2",
      depth: -10,
    },
    {
      src: "/static/landing/marketing/marketing3.png",
      alt: "Marketing Visual 3",
      depth: 20,
    },
    {
      src: "/static/landing/marketing/marketing4.png",
      alt: "Marketing Visual 4",
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
  sectionTitle: "Elevate your content strategy to new heights",
  items: [
    {
      icon: MagicWand02,
      title: "Focus on strategy",
      description:
        "Maximize impact by automating content creation and optimization tasks.",
    },
    {
      icon: CheckCircle,
      title: "Ensure consistency",
      description:
        "Maintain perfect brand alignment across all content and communication channels.",
    },
    {
      icon: Users01,
      title: "Scale production",
      description:
        "Transform your content workflow into an efficient, brand-compliant machine.",
    },
  ],
};

export const Metrics: MetricProps = {
  metrics: [
    {
      value: "70%",
      description: <>time reduction in localization</>,
    },
    {
      value: "5X",
      description: <> brand-compliant copy generation</>,
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
      title: "Content localization",
      content:
        "Translate and adapt content across languages while maintaining brand voice and cultural relevance.",
      images: ["/static/landing/marketing/localizer.png"],
    },
    {
      title: "Content optimization",
      content:
        "Transform raw content into polished, SEO-optimized pieces that align with brand guidelines.",
      images: ["/static/landing/marketing/contentOptimizer.png"],
    },
    {
      title: "Social media cross-posting",
      content:
        "Create engaging UX and social media content that consistently reflects your brand identity.",
      images: ["/static/landing/marketing/crossMedia.png"],
    },
    {
      title: "Market intelligence",
      content:
        "Monitor market movements and competitor activities to inform your content strategy and battle cards.",
      images: ["/static/landing/marketing/aiNewsletter.png"],
    },
  ],
};

export const Quote: QuoteProps = {
  quote:
    "Dust is not just a tool - it's like having an extra team member who knows your brand voice, can handle recurring tasks, and helps you tackle new challenges. I couldn't do half of my job without it, especially with tight deadlines and a small team.",
  name: "Valentine Chelius",
  title: "Head of Marketing at Fleet",
  logo: "/static/landing/logos/color/fleet.png",
};

export const DemoVideo: DemoVideoProps = {
  sectionTitle: "Watch Dust in motion",
  videoUrl: "https://fast.wistia.net/embed/iframe/z8ky9a7ugn",
  showCaptions: true,
};
