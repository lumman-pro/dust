import { CheckCircle, MagicWand02, Rocket02, Users01 } from "@dust-tt/sparkle";
import type { BenefitsProps } from "@marketing/components/home/content/Solutions/BenefitsSection";
import type { QuoteProps } from "@marketing/components/home/content/Solutions/CustomerStoriesSection";
import type { DemoVideoProps } from "@marketing/components/home/content/Solutions/DemoVideoSection";
import type { UseCaseProps } from "@marketing/components/home/content/Solutions/UseCasesSection";
import type {
  HeroProps,
  pageSettingsProps,
} from "@marketing/components/home/content/Solutions/configs/utils";

// Config exports
export const pageSettings: pageSettingsProps = {
  uptitle: "Data & Analytics",
  title: <>Turn Data Into Business Decisions</>,
  accentColor: "text-brand-red-rose",
  description: (
    <>
      Transform complex data into instant insights, automate queries, and
      democratize analytics across teams.
    </>
  ),
  bulletPoints: [
    "Enable teams to analyze data independently.",
    "Write SQL queries from natural language.",
    "Create instant data visualizations and analysis.",
    "Answer data questions with documentation context.",
  ],
  image: "/static/landing/data-analytics/analyst.png",
  seo: {
    title: "AI Data Analytics Agents: Turn Data Into Business Decisions",
    description:
      "Transform complex data into instant insights, automate queries, and democratize analytics across teams. Write SQL from natural language, create visualizations.",
  },
};

export const Hero: HeroProps = {
  uptitle: pageSettings.uptitle,
  title: pageSettings.title,
  description: pageSettings.description,
  visuals: [
    {
      src: "/static/landing/data-analytics/data1.png",
      alt: "Data Visual 1",
      depth: -30,
    },
    {
      src: "/static/landing/data-analytics/data2.png",
      alt: "Data Visual 2",
      depth: -10,
    },
    {
      src: "/static/landing/data-analytics/data3.png",
      alt: "Data Visual 3",
      depth: 20,
    },
    {
      src: "/static/landing/data-analytics/data4.png",
      alt: "Data Visual 4",
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
  sectionTitle: "Reduce toil, scale data education and deepen exploration",
  items: [
    {
      icon: MagicWand02,
      title: "Focus on insights",
      description:
        "Maximize analysis time by automating query writing and data exploration.",
    },
    {
      icon: CheckCircle,
      title: "Accelerate answers",
      description:
        "Instantly transform business questions into accurate queries and visualizations.",
    },
    {
      icon: Users01,
      title: "Democratize data",
      description:
        "Turn complex data models into accessible insights for the entire organization.",
    },
  ],
};

export const UseCases: UseCaseProps = {
  sectionTitle: "Your use cases, your way",
  sectionDescription:
    "Customize and automate tasks without writing a single line of code.",
  items: [
    {
      title: "Self-serve analytics",
      content:
        "Execute complex data queries and generate visualizations automatically to answer business questions instantly.",
      images: ["/static/landing/data-analytics/analyst.png"],
    },
    {
      title: "SQL assistant",
      content:
        "Generate, debug and optimize SQL queries that align with your business logic and data models.",
      images: ["/static/landing/data-analytics/sqlWriter.png"],
    },
    {
      title: "Data catalog",
      content:
        "Navigate your entire data ecosystem with instant access to schemas and relationships across tables.",
      images: ["/static/landing/data-analytics/dataCatalog.png"],
    },
    {
      title: "Data runbooks",
      content:
        "Access and understand data team processes and documentation to streamline operations and troubleshooting.",
      images: ["/static/landing/data-analytics/dataDoc.png"],
    },
  ],
};

export const Quote: QuoteProps = {
  quote:
    "Dust has revolutionized our partner insights, condensing days of manual research into minutes of AI-powered conversation. It's not just about efficiency and time savings—it's about making smarter decisions and doing things we could not do before.",
  name: "Alexandre Morillon",
  title: "CEO at Wakam",
  logo: "/static/landing/logos/color/wakam.svg",
};

export const DemoVideo: DemoVideoProps = {
  sectionTitle: "Watch Dust in motion",
  videoUrl: "https://fast.wistia.net/embed/iframe/9u1uft5pg7",
  showCaptions: true,
};
