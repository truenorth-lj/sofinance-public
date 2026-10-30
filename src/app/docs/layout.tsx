import { DocsShell } from "@/components/docs/docs-shell";

// Each docs page exports its own title, description and canonical (`docsPageMetadata` in src/lib/seo.ts).
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return <DocsShell>{children}</DocsShell>;
}
